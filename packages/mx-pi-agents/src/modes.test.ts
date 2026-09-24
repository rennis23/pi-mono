import { describe, expect, it, vi } from "vitest";
import { makeAgent as makePinnedAgent, makeSessionContext, mutateAgentFile } from "../test/fixtures.js";
import { type DelegationStep, displayTask, type OrchestratorDeps, runChain, runParallel, runSingle } from "./modes.js";
import type { Runner, RunPlan, RunResult } from "./types.js";

function result(agent: string, text: string, ok = true): RunResult {
	return {
		agent,
		ok,
		partial: false,
		stopped: undefined,
		text,
		truncated: false,
		durationMs: 1,
		turns: 1,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		stopReason: ok ? "end" : "error",
		errorMessage: ok ? undefined : "boom",
		diagnostics: [],
	};
}

/** A stub runner that records plans and returns scripted results. */
function stubRunner(script: (plan: RunPlan, index: number) => RunResult | Promise<RunResult>) {
	const plans: RunPlan[] = [];
	let index = 0;
	const runner: Runner = {
		kind: "process",
		async run(plan) {
			const current = index++;
			plans.push(plan);
			return script(plan, current);
		},
	};
	return { runner, plans };
}

function deps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
	const agents = [
		makePinnedAgent({ name: "explorer", tools: ["read", "grep"] }),
		makePinnedAgent({ name: "reviewer", tools: ["read"] }),
		makePinnedAgent({ name: "builder", tools: ["read", "write"] }),
	];
	return {
		agents,
		context: makeSessionContext(),
		selectRunner: () => stubRunner((plan) => result(plan.agentName, `out:${plan.task}`)).runner,
		now: () => 1000,
		...overrides,
	};
}

const options = { signal: new AbortController().signal, now: () => 1000 };

describe("runSingle", () => {
	it("plans and runs one step", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `did ${plan.task}`));
		const outcome = await runSingle(
			{ agent: "explorer", task: "find things" },
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.mode).toBe("single");
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0].text).toBe("did find things");
		expect(stub.plans[0].tools).toEqual(["read", "grep"]);
		expect(outcome.refusal).toBeUndefined();
	});

	it("refuses an unknown agent without creating a session", async () => {
		const run = vi.fn();
		const outcome = await runSingle(
			{ agent: "ghost", task: "x" },
			deps({ selectRunner: () => ({ kind: "process", run }) }),
			options,
		);

		expect(outcome.refusal?.reason).toBe("unknown-agent");
		expect(outcome.results[0].ok).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses a definition changed after pinning", async () => {
		const agent = makePinnedAgent({ name: "explorer", tools: ["read"] });
		mutateAgentFile(
			agent,
			"---\nname: explorer\ndescription: explorer description\ntools: [read, bash, write]\n---\n\nWidened.\n",
		);
		const run = vi.fn();
		const outcome = await runSingle(
			{ agent: "explorer", task: "x" },
			deps({ agents: [agent], selectRunner: () => ({ kind: "process", run }) }),
			options,
		);
		expect(outcome.refusal?.reason).toBe("definition-changed");
		expect(run).not.toHaveBeenCalled();
	});

	it("applies the authorize gate before planning", async () => {
		const run = vi.fn();
		const outcome = await runSingle(
			{ agent: "explorer", task: "x" },
			deps({
				authorize: () => ({
					ok: false,
					refusal: { reason: "unapproved-project-agent", message: "nope", diagnostics: [] },
				}),
				selectRunner: () => ({ kind: "process", run }),
			}),
			options,
		);
		expect(outcome.refusal?.reason).toBe("unapproved-project-agent");
		expect(run).not.toHaveBeenCalled();
	});

	it("turns a runner throw into a failed result", async () => {
		const outcome = await runSingle(
			{ agent: "explorer", task: "x" },
			deps({
				selectRunner: () => ({
					kind: "process",
					run: async () => {
						throw new Error("runner exploded");
					},
				}),
			}),
			options,
		);
		expect(outcome.results[0].ok).toBe(false);
		expect(outcome.results[0].errorMessage).toBe("runner exploded");
	});
});

describe("runParallel", () => {
	it("runs every task and preserves order", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `out:${plan.task}`));
		const steps: DelegationStep[] = [
			{ agent: "explorer", task: "a" },
			{ agent: "reviewer", task: "b" },
			{ agent: "builder", task: "c" },
		];
		const outcome = await runParallel(steps, deps({ selectRunner: () => stub.runner }), options);

		expect(outcome.mode).toBe("parallel");
		expect(outcome.results.map((r) => r.text)).toEqual(["out:a", "out:b", "out:c"]);
	});

	it("uses allSettled semantics: one failure does not abort the rest", async () => {
		const stub = stubRunner((plan) =>
			plan.task === "b" ? result(plan.agentName, "", false) : result(plan.agentName, `ok:${plan.task}`),
		);
		const steps: DelegationStep[] = [
			{ agent: "explorer", task: "a" },
			{ agent: "reviewer", task: "b" },
			{ agent: "builder", task: "c" },
		];
		const outcome = await runParallel(steps, deps({ selectRunner: () => stub.runner }), options);

		expect(outcome.results).toHaveLength(3);
		expect(outcome.results[1].ok).toBe(false);
		expect(outcome.results[2].text).toBe("ok:c");
	});

	it("refuses more than the task cap before running anything", async () => {
		const run = vi.fn();
		const steps = Array.from({ length: 9 }, (_, i) => ({ agent: "explorer", task: `t${i}` }));
		const outcome = await runParallel(steps, deps({ selectRunner: () => ({ kind: "process", run }) }), options);

		expect(outcome.refusal?.reason).toBe("invalid-request");
		expect(outcome.results).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});

	it("honours the concurrency ceiling", async () => {
		let live = 0;
		let peak = 0;
		const agents = [makePinnedAgent({ name: "explorer", tools: ["read"] })];
		const outcome = await runParallel(
			Array.from({ length: 6 }, (_, i) => ({ agent: "explorer", task: `t${i}` })),
			deps({
				agents,
				concurrency: 2,
				selectRunner: () => ({
					kind: "process",
					async run(plan) {
						live += 1;
						peak = Math.max(peak, live);
						await Promise.resolve();
						live -= 1;
						return result(plan.agentName, plan.task);
					},
				}),
			}),
			options,
		);
		expect(peak).toBeLessThanOrEqual(2);
		expect(outcome.results).toHaveLength(6);
	});

	it("collects per-step planning diagnostics", async () => {
		const agents = [makePinnedAgent({ name: "explorer", tools: undefined, toolsInheritance: "parent" })];
		const stub = stubRunner((plan) => result(plan.agentName, plan.task));
		const outcome = await runParallel(
			[{ agent: "explorer", task: "a" }],
			deps({
				agents,
				context: makeSessionContext({ parentTools: ["read", "ghost"], availableTools: ["read"] }),
				selectRunner: () => stub.runner,
			}),
			options,
		);
		expect(outcome.diagnostics.some((d) => d.message.includes("ghost"))).toBe(true);
	});
});

describe("runChain", () => {
	it("substitutes {previous} with the prior output", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `result(${plan.task})`));
		const outcome = await runChain(
			[
				{ agent: "explorer", task: "find bugs" },
				{ agent: "reviewer", task: "review {previous}" },
				{ agent: "builder", task: "fix {previous} please" },
			],
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.results).toHaveLength(3);
		expect(stub.plans[1].task).toBe("review result(find bugs)");
		expect(stub.plans[2].task).toBe("fix result(review result(find bugs)) please");
		expect(outcome.stoppedAt).toBeUndefined();
	});

	it("stops at the first failure and reports stoppedAt", async () => {
		const stub = stubRunner((plan) =>
			plan.task.includes("fail") ? result(plan.agentName, "", false) : result(plan.agentName, "ok"),
		);
		const outcome = await runChain(
			[
				{ agent: "explorer", task: "fail now" },
				{ agent: "reviewer", task: "never runs" },
			],
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.stoppedAt).toBe(0);
		expect(outcome.results).toHaveLength(1);
		expect(stub.plans).toHaveLength(1);
	});

	it("stops on a refusal and keeps earlier results", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, "ok"));
		const outcome = await runChain(
			[
				{ agent: "explorer", task: "a" },
				{ agent: "ghost", task: "b" },
			],
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.stoppedAt).toBe(1);
		expect(outcome.results).toHaveLength(2);
		expect(outcome.refusal?.reason).toBe("unknown-agent");
	});

	it("runs steps sequentially", async () => {
		const order: string[] = [];
		const outcome = await runChain(
			[
				{ agent: "explorer", task: "a" },
				{ agent: "reviewer", task: "b" },
			],
			deps({
				selectRunner: () => ({
					kind: "process",
					async run(plan) {
						order.push(`start:${plan.task}`);
						await Promise.resolve();
						order.push(`end:${plan.task}`);
						return result(plan.agentName, plan.task);
					},
				}),
			}),
			options,
		);
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
		expect(outcome.results).toHaveLength(2);
	});
});

describe("displayTask", () => {
	it("replaces the placeholder for display", () => {
		expect(displayTask("review {previous} now")).toBe("review … now");
	});
});
