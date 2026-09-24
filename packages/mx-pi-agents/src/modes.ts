/**
 * Delegation modes over an injected `Runner`.
 *
 * All three modes share one shape: plan each step (refusing before any child
 * session exists), run it, and return capped data. Nothing here spawns
 * processes or touches pi; that is the runner's job. Tests drive it with a
 * stub runner, which is how mode semantics (fail-fast chain, `allSettled`
 * parallel, `{previous}` substitution) are pinned down.
 */

import { MAX_CONCURRENCY, mapWithConcurrencyLimit, normalizeConcurrency, taskCountError } from "./concurrency.js";
import { describeRefusal, planRun, type SessionContext } from "./policy.js";
import { verifyPinned } from "./registry.js";
import type { AgentDiagnostic, PinnedAgent, Refusal, Runner, RunOptions, RunPlan, RunResult } from "./types.js";

/** One unit of delegated work. */
export interface DelegationStep {
	agent: string;
	task: string;
}

/** Everything the orchestrator needs besides the steps themselves. */
export interface OrchestratorDeps {
	/** Pinned roster for this session. */
	agents: readonly PinnedAgent[];
	/** Session facts for the policy layer. */
	context: SessionContext;
	/** Runner selected per plan (`process` vs `subprocess`). */
	selectRunner: (plan: RunPlan) => Runner;
	/** Injected clock, shared with budget accounting. */
	now: () => number;
	/** Concurrency for parallel mode. Defaults to MAX_CONCURRENCY. */
	concurrency?: number;
	/** Called before each step so the caller can apply the trust gate. */
	authorize?: (agent: PinnedAgent) => { ok: true } | { ok: false; refusal: Refusal };
}

/** Result of a whole delegation call. */
export interface DelegationOutcome {
	mode: "single" | "parallel" | "chain";
	results: RunResult[];
	/** Set when the run stopped early (chain failure, refusal, cap). */
	stoppedAt: number | undefined;
	/** Diagnostics from planning and running, sanitized. */
	diagnostics: AgentDiagnostic[];
	/** Populated when nothing ran at all. */
	refusal: Refusal | undefined;
}

/** A refusal that happened before any child session existed. */
function refusalResult(refusal: Refusal): RunResult {
	return {
		agent: "(none)",
		ok: false,
		partial: false,
		stopped: "child-error",
		text: describeRefusal(refusal),
		truncated: false,
		durationMs: 0,
		turns: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		stopReason: undefined,
		errorMessage: refusal.message,
		diagnostics: refusal.diagnostics,
	};
}

/** Plan one step, applying the trust gate and hash re-verification first. */
function planStep(
	step: DelegationStep,
	deps: OrchestratorDeps,
): { ok: true; plan: RunPlan; agent: PinnedAgent } | { ok: false; refusal: Refusal } {
	const agent = deps.agents.find((candidate) => candidate.definition.name === step.agent);
	if (!agent) {
		const available = deps.agents.map((candidate) => candidate.definition.name).join(", ") || "none";
		return {
			ok: false,
			refusal: {
				reason: "unknown-agent",
				message: `unknown agent "${step.agent}". Available agents: ${available}`,
				diagnostics: [],
			},
		};
	}

	if (deps.authorize) {
		const decision = deps.authorize(agent);
		if (!decision.ok) return { ok: false, refusal: decision.refusal };
	}

	// Re-hash at spawn: a definition edited after session start must not run.
	const verified = verifyPinned(agent);
	if (!verified.ok) {
		return {
			ok: false,
			refusal: { reason: "definition-changed", message: verified.message, diagnostics: [] },
		};
	}

	const planned = planRun(agent, step.task, deps.context);
	if (!planned.ok) return { ok: false, refusal: planned.refusal };
	return { ok: true, plan: planned.plan, agent };
}

/** Run one planned step through the injected runner. */
async function runStep(plan: RunPlan, deps: OrchestratorDeps, options: RunOptions): Promise<RunResult> {
	const runner = deps.selectRunner(plan);
	try {
		return await runner.run(plan, options);
	} catch (err) {
		return {
			agent: plan.agentName,
			ok: false,
			partial: false,
			stopped: "child-error",
			text: "",
			truncated: false,
			durationMs: 0,
			turns: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			stopReason: undefined,
			errorMessage: err instanceof Error ? err.message : String(err),
			diagnostics: plan.diagnostics,
		};
	}
}

function failureResult(agent: string, refusal: Refusal): RunResult {
	return { ...refusalResult(refusal), agent };
}

/** Single delegation: one agent, one task. */
export async function runSingle(
	step: DelegationStep,
	deps: OrchestratorDeps,
	options: RunOptions,
): Promise<DelegationOutcome> {
	const planned = planStep(step, deps);
	if (!planned.ok) {
		return {
			mode: "single",
			results: [failureResult(step.agent, planned.refusal)],
			stoppedAt: undefined,
			diagnostics: planned.refusal.diagnostics,
			refusal: planned.refusal,
		};
	}
	const result = await runStep(planned.plan, deps, options);
	return {
		mode: "single",
		results: [result],
		stoppedAt: undefined,
		diagnostics: planned.plan.diagnostics,
		refusal: undefined,
	};
}

/** Parallel delegation: bounded fan-out, `allSettled` semantics. */
export async function runParallel(
	steps: readonly DelegationStep[],
	deps: OrchestratorDeps,
	options: RunOptions,
): Promise<DelegationOutcome> {
	const capError = taskCountError(steps.length);
	if (capError !== undefined) {
		const refusal: Refusal = { reason: "invalid-request", message: capError, diagnostics: [] };
		return { mode: "parallel", results: [], stoppedAt: undefined, diagnostics: [], refusal };
	}

	const diagnostics: AgentDiagnostic[] = [];
	const concurrency = normalizeConcurrency(deps.concurrency);
	const results = await mapWithConcurrencyLimit(
		steps,
		concurrency,
		async (step) => {
			const planned = planStep(step, deps);
			if (!planned.ok) {
				diagnostics.push(...planned.refusal.diagnostics);
				return failureResult(step.agent, planned.refusal);
			}
			diagnostics.push(...planned.plan.diagnostics);
			// allSettled: a failed step never rejects the whole call.
			return runStep(planned.plan, deps, options);
		},
		options.signal,
	);

	return { mode: "parallel", results, stoppedAt: undefined, diagnostics, refusal: undefined };
}

/** Chain delegation: sequential, `{previous}` substitution, fail-fast. */
export async function runChain(
	steps: readonly DelegationStep[],
	deps: OrchestratorDeps,
	options: RunOptions,
): Promise<DelegationOutcome> {
	const diagnostics: AgentDiagnostic[] = [];
	const results: RunResult[] = [];
	let previous = "";

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const task = step.task.replace(/\{previous\}/g, previous);
		const planned = planStep({ agent: step.agent, task }, deps);
		if (!planned.ok) {
			diagnostics.push(...planned.refusal.diagnostics);
			results.push(failureResult(step.agent, planned.refusal));
			return { mode: "chain", results, stoppedAt: index, diagnostics, refusal: planned.refusal };
		}
		diagnostics.push(...planned.plan.diagnostics);

		const result = await runStep(planned.plan, deps, options);
		results.push(result);
		if (!result.ok) {
			return { mode: "chain", results, stoppedAt: index, diagnostics, refusal: undefined };
		}
		previous = result.text;
	}

	return { mode: "chain", results, stoppedAt: undefined, diagnostics, refusal: undefined };
}

/** Substitute `{previous}` in a chain step's task for display purposes. */
export function displayTask(task: string): string {
	return task.replace(/\{previous\}/g, "…").trim();
}

export { MAX_CONCURRENCY };
