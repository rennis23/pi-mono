import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGETS } from "./budget.js";
import { describePlan, describeRefusal, planRun, type SessionContext } from "./policy.js";
import { MAX_SYSTEM_PROMPT_BYTES } from "./prompt.js";
import type { AgentDefinition, PinnedAgent, SourceKind } from "./types.js";

function makeAgent(overrides: Partial<AgentDefinition> = {}, kind: SourceKind = "global"): PinnedAgent {
	const definition: AgentDefinition = {
		name: "reviewer",
		description: "review things",
		tools: ["read", "grep"],
		toolsInheritance: "none",
		model: undefined,
		thinking: undefined,
		maxTurns: undefined,
		timeoutMs: undefined,
		tokenBudget: undefined,
		costBudget: undefined,
		isolation: "process",
		sandbox: "none",
		body: "You review code.",
		...overrides,
	};
	return {
		definition,
		source: {
			kind,
			path: `/agents/${definition.name}.md`,
			directory: "/agents",
			trusted: kind === "global" || kind === "bundled",
		},
		hash: "a".repeat(64),
		pinnedAt: 1000,
	};
}

function context(overrides: Partial<SessionContext> = {}): SessionContext {
	return {
		cwd: "/work",
		parentTools: ["read", "grep", "bash", "mx_pi_agent"],
		availableTools: ["read", "grep", "bash", "write", "mx_pi_agent"],
		limits: {},
		sandboxAvailable: true,
		isModelAvailable: () => true,
		...overrides,
	};
}

function expectPlan(outcome: ReturnType<typeof planRun>) {
	if (!outcome.ok) throw new Error(`expected plan, got refusal: ${outcome.refusal.message}`);
	return outcome.plan;
}

function expectRefusal(outcome: ReturnType<typeof planRun>, reason: string) {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) return;
	expect(outcome.refusal.reason).toBe(reason);
}

describe("planRun", () => {
	it("plans a run with explicit grants and default budgets", () => {
		const plan = expectPlan(planRun(makeAgent(), "review the diff", context()));
		expect(plan.tools).toEqual(["read", "grep"]);
		expect(plan.noTools).toBeUndefined();
		expect(plan.budgets).toEqual(DEFAULT_BUDGETS);
		expect(plan.systemPrompt).toContain("You review code.");
		expect(plan.systemPrompt).toContain("Available tools: read, grep");
	});

	it("refuses an explicit tool that does not resolve in the child", () => {
		const agent = makeAgent({ tools: ["read", "mcp__gone__tool"] });
		expectRefusal(planRun(agent, "task", context()), "unresolved-tool");
	});

	it("drops unresolved inherited tools instead of refusing", () => {
		const agent = makeAgent({ tools: undefined, toolsInheritance: "parent" });
		const plan = expectPlan(planRun(agent, "task", context()));
		expect(plan.tools).toEqual(["read", "grep", "bash"]);
		expect(plan.diagnostics.some((d) => d.message.includes("mx_pi_agent"))).toBe(false);
	});

	it("refuses when a granted tool is spawn-capable", () => {
		const agent = makeAgent({ tools: ["read", "subagent"] });
		expectRefusal(planRun(agent, "task", context()), "spawn-tool-grant");
	});

	it("refuses when the declared model is unavailable", () => {
		const agent = makeAgent({ model: "anthropic/claude-opus-4-5" });
		expectRefusal(planRun(agent, "task", context({ isModelAvailable: () => false })), "model-unavailable");
	});

	it("refuses sandbox: os when no backend exists", () => {
		const agent = makeAgent({ sandbox: "os" });
		expectRefusal(planRun(agent, "task", context({ sandboxAvailable: false })), "sandbox-unavailable");
	});

	it("refuses an empty task", () => {
		expectRefusal(planRun(makeAgent(), "   ", context()), "invalid-request");
	});

	it("computes noTools for an empty grant set", () => {
		const plan = expectPlan(planRun(makeAgent({ tools: [] }), "task", context()));
		expect(plan.tools).toEqual([]);
		expect(plan.noTools).toBe("all");
		expect(plan.systemPrompt).toContain("Available tools: none");
	});

	it("applies config ceilings and lets an agent tighten them", () => {
		const tightened = expectPlan(
			planRun(
				makeAgent({ maxTurns: 5, timeoutMs: 1000 }),
				"task",
				context({ limits: { maxTurns: 10, timeoutMs: 5000 } }),
			),
		);
		expect(tightened.budgets.maxTurns).toBe(5);
		expect(tightened.budgets.timeoutMs).toBe(1000);

		const ceiling = expectPlan(planRun(makeAgent({ maxTurns: 900 }), "task", context({ limits: { maxTurns: 10 } })));
		expect(ceiling.budgets.maxTurns).toBe(10);
	});

	it("keeps cost opt-in", () => {
		const plan = expectPlan(planRun(makeAgent(), "task", context()));
		expect(plan.budgets.costBudget).toBeUndefined();
	});

	it("truncates an oversized body and records a diagnostic", () => {
		const agent = makeAgent({ body: "x".repeat(MAX_SYSTEM_PROMPT_BYTES * 2) });
		const plan = expectPlan(planRun(agent, "task", context()));
		expect(plan.systemPrompt).toContain("definition body truncated");
		expect(plan.diagnostics.some((d) => d.message.includes("truncated"))).toBe(true);
	});

	it("carries isolation and sandbox through to the plan", () => {
		const plan = expectPlan(planRun(makeAgent({ isolation: "subprocess", sandbox: "os" }), "task", context()));
		expect(plan.isolation).toBe("subprocess");
		expect(plan.sandbox).toBe("os");
	});

	it("does not leak the cwd or paths into the system prompt", () => {
		const plan = expectPlan(planRun(makeAgent(), "task", context({ cwd: "/secret/project" })));
		expect(plan.systemPrompt).not.toContain("/secret/project");
		expect(plan.cwd).toBe("/secret/project");
	});

	it("never widens a grant from a gated source", () => {
		const agent = makeAgent({ tools: ["read"] }, "project");
		const plan = expectPlan(planRun(agent, "task", context()));
		expect(plan.tools).toEqual(["read"]);
	});

	it("strips control characters from the definition body", () => {
		const plan = expectPlan(planRun(makeAgent({ body: "line\u0007one\ntwo" }), "task", context()));
		expect(plan.systemPrompt).not.toContain("\u0007");
		expect(plan.systemPrompt).toContain("lineone");
	});
});

describe("describeRefusal", () => {
	it("renders the reason and diagnostics", () => {
		const outcome = planRun(makeAgent({ tools: ["ghost"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		const text = describeRefusal(outcome.refusal);
		expect(text).toContain("unresolved-tool");
		expect(text).toContain("ghost");
	});
});

describe("describePlan", () => {
	it("summarizes capabilities", () => {
		const plan = expectPlan(planRun(makeAgent(), "task", context()));
		const text = describePlan(plan);
		expect(text).toContain("reviewer");
		expect(text).toContain("tools=read,grep");
		expect(text).toContain("isolation=process");
	});
});
