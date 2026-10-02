import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BUDGETS } from "./budget.js";
import { describePlan, describeRefusal, planRun, type SessionContext } from "./policy.js";
import { MAX_SYSTEM_PROMPT_BYTES } from "./prompt.js";
import type { AgentDefinition, PinnedAgent, SourceKind } from "./types.js";

let workDir: string;

beforeEach(() => {
	// Scope containment requires the run cwd to exist on disk, so use a real
	// temp directory rather than a synthetic `/work` path.
	workDir = realpathSync(mkdtempSync(join(tmpdir(), "mx-pi-agents-policy-")));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeAgent(overrides: Partial<AgentDefinition> = {}, kind: SourceKind = "global"): PinnedAgent {
	const definition: AgentDefinition = {
		name: "reviewer",
		description: "review things",
		kind: "main",
		tools: ["read", "grep"],
		toolsInheritance: "none",
		scope: undefined,
		skills: undefined,
		contextFiles: undefined,
		model: undefined,
		thinking: undefined,
		maxTurns: undefined,
		timeoutMs: undefined,
		tokenBudget: undefined,
		costBudget: undefined,
		delegate: false,
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
		cwd: workDir,
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
		const agent = makeAgent({ tools: undefined, toolsInheritance: "parent", sandbox: "os" });
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

	it("resolves the scope before the model, so a malformed definition names the scope", () => {
		const agent = makeAgent({ scope: ["/"], model: "anthropic/claude-opus-4-5" });
		expectRefusal(planRun(agent, "task", context({ isModelAvailable: () => false })), "scope-invalid");
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
		const plan = expectPlan(
			planRun(
				makeAgent({ isolation: "subprocess", sandbox: "os" }),
				"task",
				// subprocess cannot be path-confined, so it needs an explicit `/` ceiling.
				context({ scopeCeiling: ["/"] }),
			),
		);
		expect(plan.isolation).toBe("subprocess");
		expect(plan.sandbox).toBe("os");
		expect(plan.scope.unrestricted).toBe(true);
	});

	it("defaults the plan scope to the cwd when nothing is declared", () => {
		const plan = expectPlan(planRun(makeAgent(), "task", context()));
		expect(plan.scope.roots).toEqual([workDir]);
		expect(plan.scope.unrestricted).toBe(false);
	});

	it("refuses an empty scope declaration", () => {
		expectRefusal(planRun(makeAgent({ scope: [] }), "task", context()), "scope-invalid");
	});

	it("refuses a scope entry that is an ancestor of cwd", () => {
		expectRefusal(planRun(makeAgent({ scope: ["/"] }), "task", context()), "scope-invalid");
	});

	it("refuses a scope entry outside a configured ceiling", () => {
		const ceilingDir = join(workDir, "ceiling");
		const sub = join(ceilingDir, "sub");
		const outside = join(workDir, "outside");
		mkdirSync(sub, { recursive: true });
		mkdirSync(outside, { recursive: true });

		const accepted = planRun(makeAgent({ scope: [sub] }), "task", context({ scopeCeiling: [ceilingDir] }));
		expect(accepted.ok).toBe(true);

		const agent = makeAgent({ scope: [outside] });
		expectRefusal(planRun(agent, "task", context({ scopeCeiling: [ceilingDir] })), "scope-invalid");
	});

	it("refuses unsandboxed bash under the default ceiling", () => {
		const agent = makeAgent({ tools: ["read", "bash"], sandbox: "none" });
		expectRefusal(planRun(agent, "task", context()), "scope-unenforceable");
	});

	it("refuses subprocess isolation under the default ceiling", () => {
		const agent = makeAgent({ isolation: "subprocess" });
		expectRefusal(planRun(agent, "task", context()), "scope-unenforceable");
	});

	it("names the escape in the unenforceable refusal", () => {
		const agent = makeAgent({ tools: ["read", "bash"] });
		const outcome = planRun(agent, "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.message).toContain("sandbox: os");
		expect(outcome.refusal.message).toContain('scope: ["/"]');
	});

	it("licenses an unconfined run under a `/` ceiling", () => {
		const agent = makeAgent({ tools: ["read", "bash"], sandbox: "none" });
		const plan = expectPlan(planRun(agent, "task", context({ scopeCeiling: ["/"] })));
		expect(plan.scope.unrestricted).toBe(true);
		expect(plan.scope.roots).toEqual(["/"]);
	});

	it("does not leak the cwd or paths into the system prompt", () => {
		const secret = join(workDir, "secret-project");
		mkdirSync(secret, { recursive: true });
		const plan = expectPlan(planRun(makeAgent(), "task", context({ cwd: secret })));
		expect(plan.systemPrompt).not.toContain(secret);
		expect(plan.cwd).toBe(secret);
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
		expect(text).toContain("scope=cwd");
	});
});

describe("policy: boundary hardening", () => {
	it("refuses a persona agent before anything else", () => {
		const outcome = planRun(makeAgent({ kind: "persona" }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("persona-child");
	});

	it("refuses a spawn-capable grant", () => {
		const outcome = planRun(makeAgent({ tools: ["read", "subagent"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("spawn-tool-grant");
	});

	it("refuses an unresolved explicit tool", () => {
		const outcome = planRun(makeAgent({ tools: ["read", "ghost"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("unresolved-tool");
	});

	it("refuses an unavailable model and an unavailable sandbox", () => {
		const model = planRun(makeAgent({ model: "ghost/model" }), "task", context({ isModelAvailable: () => false }));
		expect(model.ok).toBe(false);
		if (!model.ok) expect(model.refusal.reason).toBe("model-unavailable");
		const sandbox = planRun(makeAgent({ sandbox: "os" }), "task", context({ sandboxAvailable: false }));
		expect(sandbox.ok).toBe(false);
		if (!sandbox.ok) expect(sandbox.refusal.reason).toBe("sandbox-unavailable");
	});

	it("refuses an empty task", () => {
		const outcome = planRun(makeAgent(), "   ", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("invalid-request");
	});

	it("refuses an unconfineable vector under the default ceiling", () => {
		const outcome = planRun(makeAgent({ tools: ["bash"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("scope-unenforceable");
	});

	it("licenses an unconfined run under a / ceiling with an info diagnostic", () => {
		const plan = expectPlan(
			planRun(
				makeAgent({ tools: ["bash"], isolation: "process", sandbox: "none" }),
				"task",
				context({ scopeCeiling: ["/"] }),
			),
		);
		expect(plan.scope.unrestricted).toBe(true);
		expect(plan.diagnostics.some((d) => d.message.includes("unconfined"))).toBe(true);
	});

	it("describeRefusal lists diagnostics and describePlan summarises", () => {
		const refusal = {
			reason: "invalid-request" as const,
			message: "task must not be empty",
			diagnostics: [{ level: "info" as const, message: "note" }],
		};
		expect(describeRefusal(refusal)).toContain("Refused (invalid-request): task must not be empty");
		expect(describeRefusal(refusal)).toContain("- info: note");
		const plan = expectPlan(planRun(makeAgent({ tools: [] }), "task", context()));
		const summary = describePlan(plan);
		expect(summary).toContain("tools=none");
		expect(summary).toContain("scope=cwd");
		expect(summary).toContain("isolation=process");
	});
});

describe("policy: message and branch coverage", () => {
	it("treats every default spawn-capable name as a spawn grant", () => {
		for (const name of ["mx_pi_agent", "subagent", "spawn_subagent", "subagent_task", "Task"]) {
			const outcome = planRun(
				makeAgent({ tools: [name] }),
				"task",
				context({ availableTools: [name], parentTools: [name] }),
			);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.refusal.reason).toBe("spawn-tool-grant");
		}
	});

	it("names the offending spawn-capable tools in the refusal", () => {
		const outcome = planRun(makeAgent({ tools: ["read", "subagent"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.message).toContain("grants spawn-capable tools, which would allow unbounded recursion");
		expect(outcome.refusal.message).toContain("subagent");
	});

	it("names the unresolved explicit tools in the refusal", () => {
		const outcome = planRun(makeAgent({ tools: ["read", "ghost"] }), "task", context());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.message).toContain("grants tools that do not resolve in the child: ghost");
	});

	it("does not emit an unconfined diagnostic for a confined plan", () => {
		const plan = expectPlan(planRun(makeAgent(), "task", context()));
		expect(plan.diagnostics.some((d) => d.message.includes("unconfined"))).toBe(false);
	});

	it("names which vector the / ceiling licensed", () => {
		const bash = expectPlan(planRun(makeAgent({ tools: ["bash"] }), "task", context({ scopeCeiling: ["/"] })));
		expect(bash.diagnostics.some((d) => d.message.includes("unsandboxed bash"))).toBe(true);

		const subprocess = expectPlan(
			planRun(makeAgent({ isolation: "subprocess", sandbox: "os" }), "task", context({ scopeCeiling: ["/"] })),
		);
		expect(subprocess.diagnostics.some((d) => d.message.includes("isolation: subprocess"))).toBe(true);
	});

	it("names the unavailable model and the missing sandbox backend", () => {
		const model = planRun(makeAgent({ model: "ghost/model" }), "task", context({ isModelAvailable: () => false }));
		expect(model.ok).toBe(false);
		if (!model.ok) {
			expect(model.refusal.message).toContain('declares model "ghost/model"');
			expect(model.refusal.message).toContain("not available with configured credentials");
		}

		const sandbox = planRun(makeAgent({ sandbox: "os" }), "task", context({ sandboxAvailable: false }));
		expect(sandbox.ok).toBe(false);
		if (!sandbox.ok) {
			expect(sandbox.refusal.message).toContain("requires sandbox: os");
			expect(sandbox.refusal.message).toContain("no supported sandbox backend is available on this platform");
		}
	});

	it("keeps a sandbox: none run when the platform has no sandbox backend", () => {
		const plan = expectPlan(planRun(makeAgent({ sandbox: "none" }), "task", context({ sandboxAvailable: false })));
		expect(plan.sandbox).toBe("none");
	});

	it("reports the empty-task message verbatim", () => {
		const outcome = planRun(makeAgent(), "   ", context());
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal.message).toBe("task must not be empty");
	});

	it("separates the refusal reason and diagnostics with a newline", () => {
		const text = describeRefusal({
			reason: "invalid-request" as const,
			message: "task must not be empty",
			diagnostics: [
				{ level: "info" as const, message: "first" },
				{ level: "warning" as const, message: "second" },
			],
		});
		expect(text).toBe("Refused (invalid-request): task must not be empty\n- info: first\n- warning: second");
	});
});
