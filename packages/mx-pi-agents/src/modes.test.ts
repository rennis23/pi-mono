import { describe, expect, it, vi } from "vitest";
import { makeAgent as makePinnedAgent, makeSessionContext, mutateAgentFile } from "../test/fixtures.js";
import {
	type DelegationStep,
	displayTask,
	type OrchestratorDeps,
	runChain,
	runParallel,
	runPipeline,
	runSingle,
} from "./modes.js";
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

describe("runPipeline", () => {
	it("runs a single-stage pipeline with the caller's task", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `did:${plan.task}`));
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }],
			"find it",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.mode).toBe("pipeline");
		expect(outcome.results).toHaveLength(1);
		expect(stub.plans[0].task).toBe("find it");
		expect(outcome.stoppedAt).toBeUndefined();
	});

	it("cascades {previous} through sequential stages", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `out(${plan.task})`));
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer"] }, { agents: ["builder"] }],
			"find bugs",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(stub.plans.map((plan) => plan.task)).toEqual(["find bugs", "out(find bugs)", "out(out(find bugs))"]);
		expect(outcome.results).toHaveLength(3);
	});

	it("runs a parallel group with one {previous} and labels its combined output", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `out(${plan.task})`));
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer", "builder"] }, { agents: ["reviewer"] }],
			"find bugs",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		// The parallel group's two members share the same substituted task.
		expect(stub.plans[1].task).toBe("out(find bugs)");
		expect(stub.plans[2].task).toBe("out(find bugs)");
		// The next stage receives both results, labelled by agent.
		expect(stub.plans[3].task).toBe("--- reviewer ---\nout(out(find bugs))\n\n--- builder ---\nout(out(find bugs))");
		expect(outcome.results).toHaveLength(4);
	});

	it("stops at the first failed stage", async () => {
		const stub = stubRunner((plan) =>
			plan.task.includes("fail") ? result(plan.agentName, "", false) : result(plan.agentName, "ok"),
		);
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer"] }],
			"fail now",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.stoppedAt).toBe(0);
		expect(outcome.results).toHaveLength(1);
		expect(stub.plans).toHaveLength(1);
	});

	it("stops when every member of a parallel group fails", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, "", false));
		const outcome = await runPipeline(
			[{ agents: ["reviewer", "builder"] }, { agents: ["explorer"] }],
			"go",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.stoppedAt).toBe(0);
		expect(outcome.results).toHaveLength(2);
		expect(stub.plans).toHaveLength(2);
	});

	it("continues a parallel group when at least one member succeeds", async () => {
		const stub = stubRunner((plan) =>
			plan.agentName === "reviewer"
				? result(plan.agentName, "", false)
				: result(plan.agentName, `out(${plan.task})`),
		);
		const outcome = await runPipeline(
			[{ agents: ["reviewer", "builder"] }, { agents: ["explorer"] }],
			"go",
			deps({ selectRunner: () => stub.runner }),
			options,
		);

		expect(outcome.stoppedAt).toBeUndefined();
		expect(outcome.results).toHaveLength(3);
		expect(stub.plans[2].task).toBe("--- builder ---\nout(go)");
	});

	it("refuses more than the parallel group cap before running", async () => {
		const run = vi.fn();
		const agents = Array.from({ length: 9 }, () => "explorer");
		const outcome = await runPipeline(
			[{ agents }],
			"go",
			deps({ selectRunner: () => ({ kind: "process", run }) }),
			options,
		);

		expect(outcome.refusal?.reason).toBe("invalid-request");
		expect(outcome.results).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses more than the stage cap before running", async () => {
		const run = vi.fn();
		const stages = Array.from({ length: 17 }, () => ({ agents: ["explorer"] }));
		const outcome = await runPipeline(
			stages,
			"go",
			deps({ selectRunner: () => ({ kind: "process", run }) }),
			options,
		);

		expect(outcome.refusal?.reason).toBe("invalid-request");
		expect(outcome.refusal?.message).toContain("stages");
		expect(run).not.toHaveBeenCalled();
	});

	it("propagates an authorize refusal and keeps earlier results", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, "ok"));
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["builder"] }],
			"go",
			deps({
				selectRunner: () => stub.runner,
				authorize: (agent) =>
					agent.definition.name === "builder"
						? { ok: false, refusal: { reason: "unapproved-project-agent", message: "nope", diagnostics: [] } }
						: { ok: true },
			}),
			options,
		);

		expect(outcome.stoppedAt).toBe(1);
		expect(outcome.refusal?.reason).toBe("unapproved-project-agent");
		expect(outcome.results).toHaveLength(2);
		expect(stub.plans).toHaveLength(1);
	});

	it("runs a mixed parallel/sequential pipeline in order", async () => {
		const order: string[] = [];
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer", "builder"] }, { agents: ["explorer"] }],
			"go",
			deps({
				selectRunner: () => ({
					kind: "process",
					async run(plan) {
						order.push(`start:${plan.agentName}`);
						await Promise.resolve();
						order.push(`end:${plan.agentName}`);
						return result(plan.agentName, plan.agentName);
					},
				}),
			}),
			options,
		);

		expect(outcome.results).toHaveLength(4);
		expect(order[0]).toBe("start:explorer");
		expect(order[order.length - 1]).toBe("end:explorer");
	});

	it("refuses an empty or malformed stage count", async () => {
		const outcome = await runPipeline([], "go", deps(), options);
		expect(outcome.refusal?.reason).toBe("invalid-request");
	});
});

describe("displayTask", () => {
	it("replaces the placeholder for display", () => {
		expect(displayTask("review {previous} now")).toBe("review … now");
	});
});

describe("step lifecycle (onStep)", () => {
	function collector() {
		const events: Array<{ phase: string; stage: number; agent: string; ok?: boolean }> = [];
		return {
			events,
			onStep: (event: { phase: string; stage: number; agent: string; ok?: boolean }) => events.push(event),
		};
	}

	it("reports start then settle for a single run", async () => {
		const collected = collector();
		await runSingle(
			{ agent: "explorer", task: "x" },
			deps({
				onStep: collected.onStep,
				selectRunner: () => stubRunner((plan) => result(plan.agentName, "ok")).runner,
			}),
			options,
		);
		expect(collected.events).toEqual([
			{ phase: "start", stage: 0, agent: "explorer" },
			{ phase: "settle", stage: 0, agent: "explorer", ok: true },
		]);
	});

	it("numbers chain stages sequentially", async () => {
		const collected = collector();
		await runChain(
			[
				{ agent: "explorer", task: "a" },
				{ agent: "reviewer", task: "b" },
			],
			deps({
				onStep: collected.onStep,
				selectRunner: () => stubRunner((plan) => result(plan.agentName, "ok")).runner,
			}),
			options,
		);
		expect(collected.events.map((event) => [event.phase, event.stage, event.agent])).toEqual([
			["start", 0, "explorer"],
			["settle", 0, "explorer"],
			["start", 1, "reviewer"],
			["settle", 1, "reviewer"],
		]);
	});

	it("puts every parallel step in stage 0", async () => {
		const collected = collector();
		await runParallel(
			[
				{ agent: "explorer", task: "a" },
				{ agent: "reviewer", task: "b" },
			],
			deps({
				onStep: collected.onStep,
				selectRunner: () => stubRunner((plan) => result(plan.agentName, "ok")).runner,
			}),
			options,
		);
		expect(collected.events).toHaveLength(4);
		expect(collected.events.every((event) => event.stage === 0)).toBe(true);
	});

	it("groups a pipeline's parallel members under one stage", async () => {
		const collected = collector();
		await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer", "builder"] }],
			"go",
			deps({
				onStep: collected.onStep,
				selectRunner: () => stubRunner((plan) => result(plan.agentName, "ok")).runner,
			}),
			options,
		);
		const starts = collected.events.filter((event) => event.phase === "start");
		expect(starts.map((event) => event.stage)).toEqual([0, 1, 1]);
		expect(starts.map((event) => event.agent).sort()).toEqual(["builder", "explorer", "reviewer"]);
	});

	it("does not report a step that refused to plan", async () => {
		const collected = collector();
		const outcome = await runSingle({ agent: "ghost", task: "x" }, deps({ onStep: collected.onStep }), options);
		expect(outcome.refusal?.reason).toBe("unknown-agent");
		expect(collected.events).toEqual([]);
	});

	it("reports a failed settle", async () => {
		const collected = collector();
		await runSingle(
			{ agent: "explorer", task: "x" },
			deps({
				onStep: collected.onStep,
				selectRunner: () => stubRunner((plan) => result(plan.agentName, "", false)).runner,
			}),
			options,
		);
		expect(collected.events[1]).toEqual({ phase: "settle", stage: 0, agent: "explorer", ok: false });
	});
});

describe("modes: boundary hardening", () => {
	it("refusal results carry the child-error shape", async () => {
		const outcome = await runSingle({ agent: "ghost", task: "x" }, deps(), options);
		const [failure] = outcome.results;
		expect(failure.agent).toBe("ghost");
		expect(failure.ok).toBe(false);
		expect(failure.partial).toBe(false);
		expect(failure.stopped).toBe("child-error");
	});

	it("runParallel rejects too many tasks", async () => {
		const steps: DelegationStep[] = Array.from({ length: 9 }, () => ({ agent: "explorer", task: "t" }));
		const outcome = await runParallel(steps, deps(), options);
		expect(outcome.refusal?.reason).toBe("invalid-request");
		expect(outcome.results).toEqual([]);
	});

	it("runParallel keeps failed steps as data", async () => {
		const stub = stubRunner((plan, index) => result(plan.agentName, "x", index !== 0));
		const outcome = await runParallel(
			[
				{ agent: "explorer", task: "a" },
				{ agent: "reviewer", task: "b" },
			],
			deps({ selectRunner: () => stub.runner }),
			options,
		);
		expect(outcome.results.map((entry) => entry.ok)).toEqual([false, true]);
	});

	it("runChain substitutes {previous} and stops on the first failure", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `out:${plan.task}`));
		const outcome = await runChain(
			[
				{ agent: "explorer", task: "first" },
				{ agent: "reviewer", task: "uses {previous}" },
			],
			deps({ selectRunner: () => stub.runner }),
			options,
		);
		expect(outcome.results[1].text).toBe("out:uses out:first");
		expect(outcome.stoppedAt).toBeUndefined();

		const failing = stubRunner((plan, index) => result(plan.agentName, "x", index !== 0));
		const stopped = await runChain(
			[
				{ agent: "explorer", task: "first" },
				{ agent: "reviewer", task: "second" },
			],
			deps({ selectRunner: () => failing.runner }),
			options,
		);
		expect(stopped.stoppedAt).toBe(0);
		expect(stopped.results).toHaveLength(1);
	});

	it("runPipeline validates the stage count", async () => {
		const tooFew = await runPipeline([], "task", deps(), options);
		expect(tooFew.refusal?.reason).toBe("invalid-request");
		const tooMany = await runPipeline(
			Array.from({ length: 17 }, () => ({ agents: ["explorer"] })),
			"task",
			deps(),
			options,
		);
		expect(tooMany.refusal?.message).toContain("1..16");
	});

	it("runPipeline cascades {previous} through single-agent stages", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, `out:${plan.task}`));
		const outcome = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer"] }],
			"first",
			deps({ selectRunner: () => stub.runner }),
			options,
		);
		expect(outcome.results[0].text).toBe("out:first");
		expect(outcome.results[1].text).toBe("out:out:first");
		expect(outcome.stoppedAt).toBeUndefined();
	});

	it("runPipeline stops a failed single stage and runs parallel groups", async () => {
		const failing = stubRunner((plan, index) => result(plan.agentName, "x", index !== 0));
		const stopped = await runPipeline(
			[{ agents: ["explorer"] }, { agents: ["reviewer"] }],
			"first",
			deps({ selectRunner: () => failing.runner }),
			options,
		);
		expect(stopped.stoppedAt).toBe(0);

		const group = stubRunner((plan) => result(plan.agentName, `out:${plan.task}`));
		const combined = await runPipeline(
			[{ agents: ["explorer", "reviewer"] }],
			"first",
			deps({ selectRunner: () => group.runner }),
			options,
		);
		expect(combined.results).toHaveLength(2);
	});

	it("displayTask substitutes {previous} with an ellipsis and trims", () => {
		expect(displayTask("  use {previous} now  ")).toBe("use … now");
	});
});

describe("modes: survivor kills", () => {
	it("shapes a refusal result with (none), empty text and false flags", async () => {
		const outcome = await runSingle({ agent: "ghost", task: "t" }, deps(), options);
		const [refusalResult] = outcome.results;
		expect(refusalResult.agent).toBe("ghost");
		expect(refusalResult.partial).toBe(false);
		expect(refusalResult.truncated).toBe(false);
		expect(refusalResult.text).toContain("Refused");
	});

	it("lists the available agents in the unknown-agent refusal", async () => {
		const outcome = await runSingle({ agent: "ghost", task: "t" }, deps(), options);
		expect(outcome.refusal?.message).toContain("explorer, reviewer, builder");
	});

	it("shapes a runner throw as an empty, non-partial result", async () => {
		const runner: Runner = {
			kind: "process",
			async run() {
				throw new Error("kaboom");
			},
		};
		const outcome = await runSingle({ agent: "explorer", task: "t" }, deps({ selectRunner: () => runner }), options);
		expect(outcome.results[0].partial).toBe(false);
		expect(outcome.results[0].truncated).toBe(false);
		expect(outcome.results[0].text).toBe("");
		expect(outcome.results[0].errorMessage).toBe("kaboom");
	});

	it("starts a chain with an empty previous value", async () => {
		const stub = stubRunner((plan) => result(plan.agentName, "x"));
		const outcome = await runChain(
			[{ agent: "explorer", task: "do {previous} now" }],
			deps({ selectRunner: () => stub.runner }),
			options,
		);
		expect(outcome.results).toHaveLength(1);
		expect(stub.plans[0].task).toBe("do  now");
	});

	it("accepts exactly the maximum number of pipeline stages", async () => {
		const stages = Array.from({ length: 16 }, () => ({ agents: ["explorer"] }));
		const outcome = await runPipeline(stages, "go", deps(), options);
		expect(outcome.refusal).toBeUndefined();
		expect(outcome.results).toHaveLength(16);
	});

	it("refuses a stage above the task cap with a stage-specific message", async () => {
		const outcome = await runPipeline(
			[{ agents: Array.from({ length: 9 }, () => "explorer") }],
			"go",
			deps(),
			options,
		);
		expect(outcome.refusal?.reason).toBe("invalid-request");
		expect(outcome.refusal?.message).toContain("invalid pipeline stage:");
	});

	it("propagates authorize diagnostics in chain and pipeline", async () => {
		const authorize = () => ({
			ok: false as const,
			refusal: {
				reason: "unapproved-project-agent" as const,
				message: "gated",
				diagnostics: [{ level: "info" as const, message: "from-auth" }],
			},
		});
		const chain = await runChain([{ agent: "explorer", task: "t" }], deps({ authorize }), options);
		expect(chain.diagnostics.some((d) => d.message === "from-auth")).toBe(true);
		const pipeline = await runPipeline([{ agents: ["explorer"] }], "t", deps({ authorize }), options);
		expect(pipeline.diagnostics.some((d) => d.message === "from-auth")).toBe(true);
	});
});
