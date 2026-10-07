/**
 * Main-session persona switching.
 *
 * This module is pure and pi-free: it takes a pinned definition plus a small
 * snapshot of the main session's runtime facts and returns a `SwitchPlan`, a
 * refusal, a reset payload or a rehydration decision. `index.ts` applies the
 * result verbatim and owns no interpretation of its own.
 *
 * Everything here is fail-closed: a declared tool that does not resolve in the
 * main session or a declared model that is unavailable refuses the whole
 * switch, so a partial preset is never applied.
 */

import type {
	PinnedAgent,
	SwitchApplied,
	SwitchBaseline,
	SwitchEntryData,
	SwitchPlan,
	SystemPromptMode,
	ThinkingLevel,
} from "./types.js";

/** What a single-name `#name [task]` directive should do. */
export type DirectiveDispatch =
	| { action: "reset" }
	| { action: "switch"; mode: SystemPromptMode }
	| { action: "delegate" }
	| { action: "refuse"; message: string };

/** Name of the built-in reset directive. A definition may never claim it. */
export const RESET_NAME = "none";

/**
 * Decide what a single-name directive does, from the resolved definition.
 *
 * `definition` is `undefined` when no definition owns the name, so an unknown
 * name refuses here rather than reaching the model or the delegation path.
 */
export function dispatchDirective(input: {
	name: string;
	definition: { systemPrompt: SystemPromptMode; subAgentOnly: boolean } | undefined;
	hasTask: boolean;
}): DirectiveDispatch {
	if (input.name === RESET_NAME) {
		if (input.hasTask) return { action: "refuse", message: `"#${RESET_NAME}" takes no task.` };
		return { action: "reset" };
	}
	if (input.definition === undefined) {
		return { action: "refuse", message: `unknown agent "#${input.name}".` };
	}
	if (input.definition.subAgentOnly) {
		if (!input.hasTask) return { action: "refuse", message: `subagent "${input.name}" needs a task.` };
		return { action: "delegate" };
	}
	return { action: "switch", mode: input.definition.systemPrompt };
}

/** The spawn-capable tool a delegating main-session switch keeps active. */
export const DELEGATE_TOOL = "mx_pi_agent";

/** Runtime facts the main-session switch needs. None come from the target repo. */
export interface SwitchContext {
	/** Every tool name that resolves in the main session. */
	availableTools: readonly string[];
	/** Names currently active in the main session (`pi.getActiveTools()`). */
	currentTools: readonly string[];
	/** Whether a declared `provider/id` model is available with credentials. */
	isModelAvailable: (model: string) => boolean;
}

export type SwitchOutcome = { ok: true; plan: SwitchPlan } | { ok: false; refusal: string };

/**
 * Build a switch plan or refuse.
 *
 * Absent fields are left untouched (`applied` omits them); present-but-empty
 * `tools` means "no tools", per the total-grants contract. Every declared name
 * must resolve, otherwise nothing is applied.
 */
export function planSwitch(agent: PinnedAgent, ctx: SwitchContext): SwitchOutcome {
	const definition = agent.definition;
	if (definition.subAgentOnly) {
		return { ok: false, refusal: `agent "${definition.name}" is not a main-session agent.` };
	}

	const applied: SwitchApplied = {};

	if (definition.delegate) {
		// The declared preset wins; otherwise union the delegate tool onto whatever
		// is active now, so switching from a narrowed agent (#planner) to an
		// orchestrator restores the delegation capability.
		const base = definition.tools ?? ctx.currentTools;
		const merged = [...new Set([...base, DELEGATE_TOOL])];
		const unresolved = merged.filter((name) => !ctx.availableTools.includes(name));
		if (unresolved.length > 0) {
			return {
				ok: false,
				refusal: `agent "${definition.name}" declares tools that do not resolve in the main session: ${unresolved.join(", ")}`,
			};
		}
		applied.tools = merged;
	} else if (definition.tools !== undefined) {
		const unresolved = definition.tools.filter((name) => !ctx.availableTools.includes(name));
		if (unresolved.length > 0) {
			return {
				ok: false,
				refusal: `agent "${definition.name}" declares tools that do not resolve in the main session: ${unresolved.join(", ")}`,
			};
		}
		applied.tools = [...definition.tools];
	}

	if (definition.model !== undefined) {
		if (!ctx.isModelAvailable(definition.model)) {
			return {
				ok: false,
				refusal: `agent "${definition.name}" declares model "${definition.model}", which is not available with configured credentials`,
			};
		}
		applied.model = definition.model;
	}

	if (definition.thinking !== undefined) applied.thinking = definition.thinking;

	return {
		ok: true,
		plan: {
			name: definition.name,
			mode: definition.systemPrompt,
			applied,
		},
	};
}

/** Capture the pre-switch runtime state. */
export function snapshotBaseline(current: {
	tools: readonly string[];
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
}): SwitchBaseline {
	return { tools: [...current.tools], model: current.model, thinking: current.thinking };
}

/** The runtime state a switch leaves behind: baseline with `applied` overrides. */
export function applyOverrides(baseline: SwitchBaseline, applied: SwitchApplied): SwitchBaseline {
	return {
		tools: applied.tools !== undefined ? [...applied.tools] : [...baseline.tools],
		model: applied.model !== undefined ? applied.model : baseline.model,
		thinking: applied.thinking !== undefined ? applied.thinking : baseline.thinking,
	};
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].sort();
	const right = [...b].sort();
	return left.every((value, index) => value === right[index]);
}

/** Whether the live runtime exactly matches a target state. */
export function runtimeMatches(
	current: { tools: readonly string[]; model: string | undefined; thinking: ThinkingLevel | undefined },
	target: SwitchBaseline,
): boolean {
	return (
		sameTools(current.tools, target.tools) && current.model === target.model && current.thinking === target.thinking
	);
}

/** A reset payload: the baseline values, plus what could not be restored. */
export interface RestorePlan {
	tools: string[];
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	warnings: string[];
}

/**
 * Plan a `#none` restore. Values that no longer resolve are dropped with a
 * warning; the rest is still restored, so a reset always lands on the base
 * prompt even if one tool or the model disappeared mid-session.
 */
export function planReset(baseline: SwitchBaseline, ctx: SwitchContext): RestorePlan {
	const warnings: string[] = [];
	const tools = baseline.tools.filter((name) => {
		if (ctx.availableTools.includes(name)) return true;
		warnings.push(`tool "${name}" no longer resolves and was not restored`);
		return false;
	});
	let model = baseline.model;
	if (model !== undefined && !ctx.isModelAvailable(model)) {
		warnings.push(`model "${model}" is no longer available and was not restored`);
		model = undefined;
	}
	return { tools, model, thinking: baseline.thinking, warnings };
}

/** Minimal shape of a session branch entry the rehydrator reads. */
export interface BranchEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Validate persisted switch data, rejecting anything malformed. */
export function parseSwitchEntry(data: unknown): SwitchEntryData | undefined {
	if (!isRecord(data)) return undefined;
	if (data.name !== null && typeof data.name !== "string") return undefined;
	if (data.name !== null && data.mode !== "replace" && data.mode !== "append") return undefined;
	if (typeof data.switchedAt !== "number" || !Number.isFinite(data.switchedAt)) return undefined;

	const baseline = data.baseline;
	if (!isRecord(baseline) || !Array.isArray(baseline.tools)) return undefined;
	const tools = baseline.tools.filter((name): name is string => typeof name === "string");
	if (tools.length !== baseline.tools.length) return undefined;
	const model = baseline.model;
	if (model !== undefined && model !== null && typeof model !== "string") return undefined;

	const appliedRaw = data.applied;
	let applied: SwitchApplied | undefined;
	if (appliedRaw !== undefined) {
		if (!isRecord(appliedRaw)) return undefined;
		applied = {};
		if (appliedRaw.tools !== undefined) {
			if (!Array.isArray(appliedRaw.tools)) return undefined;
			const appliedTools = appliedRaw.tools.filter((name): name is string => typeof name === "string");
			if (appliedTools.length !== appliedRaw.tools.length) return undefined;
			applied.tools = appliedTools;
		}
		if (appliedRaw.model !== undefined) {
			if (typeof appliedRaw.model !== "string") return undefined;
			applied.model = appliedRaw.model;
		}
		if (appliedRaw.thinking !== undefined) {
			if (typeof appliedRaw.thinking !== "string") return undefined;
			applied.thinking = appliedRaw.thinking as ThinkingLevel;
		}
	}

	return {
		name: data.name as string | null,
		mode: data.mode as SystemPromptMode | undefined,
		baseline: {
			tools,
			model: (model ?? undefined) as string | undefined,
			thinking: baseline.thinking as ThinkingLevel | undefined,
		},
		applied,
		switchedAt: data.switchedAt,
	};
}

/** Last switch entry on a branch, or `undefined` when the branch has none. */
export function lastSwitchEntry(entries: readonly BranchEntryLike[]): SwitchEntryData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === "mx-pi-agents.switch") {
			return parseSwitchEntry(entry.data);
		}
	}
	return undefined;
}

/** Outcome of rehydrating a session's persisted switch. */
export type RehydrateDecision =
	| { active: false }
	| {
			active: true;
			name: string;
			mode: SystemPromptMode;
			baseline: SwitchBaseline;
			applied: SwitchApplied;
			/** True when the live runtime still matches the baseline and must be re-applied. */
			applyPreset: boolean;
	  };

/**
 * Decide how a persisted switch should be re-applied to a resumed session.
 *
 * The prompt is always re-derived from the active definition; the preset is
 * re-applied only when the live runtime still reflects the switch (it matches
 * either the applied state or the pristine baseline). Anything else means the
 * user changed tools/model/thinking deliberately and is left alone.
 */
export function rehydrate(
	entry: SwitchEntryData | undefined,
	current: { tools: readonly string[]; model: string | undefined; thinking: ThinkingLevel | undefined },
): RehydrateDecision {
	if (!entry || entry.name === null || (entry.mode !== "replace" && entry.mode !== "append")) {
		return { active: false };
	}
	const applied = entry.applied ?? {};
	const target = applyOverrides(entry.baseline, applied);
	const alreadyApplied = runtimeMatches(current, target);
	const pristine = runtimeMatches(current, entry.baseline);
	return {
		active: true,
		name: entry.name,
		mode: entry.mode,
		baseline: entry.baseline,
		applied,
		applyPreset: !alreadyApplied && pristine,
	};
}
