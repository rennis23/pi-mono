/**
 * Shared data shapes for mx-pi-context-stats.
 *
 * Kept dependency-free so every module here (and every test) can be exercised
 * without a live pi session or TUI.
 */

/** Placement of the stats widget relative to the editor. Mirrors pi's `WidgetPlacement`. */
export type StatsPlacement = "aboveEditor" | "belowEditor";

/** Status of a tracked subagent tool call. */
export type SubagentStatus = "running" | "done" | "error";

/**
 * A completed prompt, as recorded on `agent_end`.
 *
 * `contextTokens` is the context size *after* the prompt finished, which is why
 * the widget treats consecutive snapshots as a growth series.
 */
export interface PromptSnapshot {
	promptNum: number;
	contextTokens: number;
	contextWindow: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	/** Number of LLM turns (assistant messages) inside this prompt. */
	turns: number;
	/** Mean output tokens/second across the prompt's turns. 0 when unmeasurable. */
	tokPerSec: number;
	/** Wall-clock seconds from prompt submission to `agent_end`. */
	duration: number;
	/** True when a compaction happened between the previous snapshot and this one. */
	compacted: boolean;
}

/** A subagent (or any `spawn_subagent`-shaped tool call) being tracked. */
export interface SubagentInfo {
	toolCallId: string;
	agentName: string;
	tools: string[];
	model: string | undefined;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	cost: number;
	status: SubagentStatus;
	/** Prompt number the subagent was spawned from. */
	promptNum: number;
	/** `Date.now()` at `tool_execution_start`. */
	startTime: number;
	/** Seconds elapsed at `tool_execution_end`; 0 while running. */
	duration: number;
	/** outputTokens / duration. 0 while running or when unmeasurable. */
	tokPerSec: number;
}

/** The subset of pi's `ContextUsage` this extension reads. */
export interface UsageSnapshot {
	/** Null when pi cannot estimate usage (e.g. right after compaction). */
	tokens: number | null;
	contextWindow: number;
}

/** The subset of pi's `Usage` this extension accumulates per turn. */
export interface TurnUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

/**
 * Normalized fields extracted from a subagent progress/result payload.
 *
 * Payload shapes differ between subagent implementations, so `subagents.ts`
 * reduces them all to this before touching state.
 */
export interface SubagentPatch {
	usage?: {
		turns?: number;
		input?: number;
		output?: number;
		context?: number;
		cost?: number;
	};
	model?: string;
	tools?: string[];
}
