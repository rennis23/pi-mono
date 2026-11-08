/**
 * Runner selection.
 *
 * A runner is chosen from the plan's `isolation` field alone. `process` and
 * `subprocess` are both supported; anything else is a refusal upstream, so
 * selection here is total.
 */

import type { IsolationMode, Runner, RunPlan } from "./types.js";

export interface RunnerRegistry {
	/** In-process SDK session runner. */
	process: Runner;
	/** Spawned `pi` child runner. */
	subprocess: Runner;
}

/** Select the runner for a plan. */
export function selectRunner(registry: RunnerRegistry, plan: RunPlan): Runner {
	const mode: IsolationMode = plan.isolation === "subprocess" ? "subprocess" : "process";
	return registry[mode];
}

/** A runner that always refuses; used when a backend is unavailable. */
export function unavailableRunner(kind: IsolationMode, message: string): Runner {
	return {
		kind,
		async run(plan) {
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
				errorMessage: message,
				diagnostics: plan.diagnostics,
			};
		},
	};
}
