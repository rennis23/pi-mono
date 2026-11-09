/**
 * Mutable session state for mx-pi-context-stats.
 *
 * All timing is passed in by the caller (`now`), never read from `Date.now()`
 * inside this module, so every code path is deterministic under test. The
 * extension owns one instance per session and resets it on `session_start`.
 */

import type { ContextStatsOptions } from "./options.js";
import { applySubagentPatch, parseSpawnArgs, parseSubagentPayload } from "./subagents.js";
import type { PromptSnapshot, SubagentInfo, TurnUsage, UsageSnapshot } from "./types.js";

export interface StatsState {
	/** Options are owned here so `/mx-pi-settings` overrides apply to later renders. */
	options: ContextStatsOptions;
	/** Rolling window of completed prompts, oldest first. */
	history: PromptSnapshot[];
	/** Every subagent seen this session, in spawn order. */
	subagents: SubagentInfo[];
	/** Last known context size; null when pi cannot estimate it. */
	contextTokens: number | null;
	contextWindow: number;
	/** Output tok/s of the most recent assistant message. */
	lastTokPerSec: number | undefined;
	/** Wall-clock seconds of the most recent completed prompt. */
	lastDuration: number | undefined;

	reset(contextWindow: number): void;
	setContextWindow(contextWindow: number): void;
	beginPrompt(now: number): void;
	noteUserTurn(now: number): void;
	recordTurn(usage: TurnUsage): void;
	noteFirstToken(now: number): void;
	completeMessage(outputTokens: number, now: number): void;
	endPrompt(usage: UsageSnapshot | undefined, now: number): PromptSnapshot;
	markCompacted(): void;
	startSubagent(toolCallId: string, args: unknown, now: number): SubagentInfo;
	updateSubagent(toolCallId: string, payload: unknown): void;
	endSubagent(toolCallId: string, isError: boolean, payload: unknown, now: number): void;
	clearHistory(): void;
}

/** Minimum streaming window (seconds) for a tok/s sample; below this it is noise. */
export const MIN_SAMPLE_SECONDS = 0.1;

export function createStatsState(initial: ContextStatsOptions): StatsState {
	const byToolCallId = new Map<string, SubagentInfo>();

	let promptNum = 0;
	let promptInput = 0;
	let promptOutput = 0;
	let promptCacheRead = 0;
	let promptCacheWrite = 0;
	let promptCost = 0;
	let promptTurns = 0;
	let requestStart: number | undefined;
	let firstTokenTime: number | undefined;
	let tokSamples: number[] = [];
	let compactionPending = false;

	const state: StatsState = {
		options: initial,
		history: [],
		subagents: [],
		contextTokens: null,
		contextWindow: 0,
		lastTokPerSec: undefined,
		lastDuration: undefined,

		reset(contextWindow: number): void {
			state.history.length = 0;
			state.subagents.length = 0;
			byToolCallId.clear();
			promptNum = 0;
			promptInput = 0;
			promptOutput = 0;
			promptCacheRead = 0;
			promptCacheWrite = 0;
			promptCost = 0;
			promptTurns = 0;
			requestStart = undefined;
			firstTokenTime = undefined;
			tokSamples = [];
			compactionPending = false;
			state.contextTokens = null;
			state.contextWindow = contextWindow;
			state.lastTokPerSec = undefined;
			state.lastDuration = undefined;
		},

		setContextWindow(contextWindow: number): void {
			if (Number.isFinite(contextWindow) && contextWindow > 0) state.contextWindow = contextWindow;
		},

		beginPrompt(now: number): void {
			promptNum++;
			promptInput = 0;
			promptOutput = 0;
			promptCacheRead = 0;
			promptCacheWrite = 0;
			promptCost = 0;
			promptTurns = 0;
			firstTokenTime = undefined;
			tokSamples = [];
			// Each prompt times from its own submission. Previously the timer was
			// only set when undefined, so it survived across prompts and the
			// measured duration grew monotonically from session start.
			requestStart = now;
			state.lastDuration = undefined;
		},

		/** A user turn restarts the clock: the wait for input is not work. */
		noteUserTurn(now: number): void {
			requestStart = now;
		},

		recordTurn(usage: TurnUsage): void {
			promptInput += usage.input ?? 0;
			promptOutput += usage.output ?? 0;
			promptCacheRead += usage.cacheRead ?? 0;
			promptCacheWrite += usage.cacheWrite ?? 0;
			promptCost += usage.cost?.total ?? 0;
			promptTurns++;
		},

		noteFirstToken(now: number): void {
			if (firstTokenTime === undefined) {
				firstTokenTime = now;
				if (requestStart === undefined) requestStart = now;
			}
		},

		completeMessage(outputTokens: number, now: number): void {
			if (firstTokenTime === undefined) return;
			const secs = (now - firstTokenTime) / 1000;
			firstTokenTime = undefined;
			// Ignore implausibly short windows: they produce wild tok/s outliers.
			if (secs >= MIN_SAMPLE_SECONDS && outputTokens > 0) {
				const tps = outputTokens / secs;
				tokSamples.push(tps);
				state.lastTokPerSec = tps;
			}
		},

		endPrompt(usage: UsageSnapshot | undefined, now: number): PromptSnapshot {
			if (usage) {
				state.contextTokens = usage.tokens ?? null;
				state.setContextWindow(usage.contextWindow);
			}

			// endPrompt is the single owner of lastDuration: whole-prompt wall
			// clock from submission. Computed before the snapshot is taken.
			if (requestStart !== undefined) {
				state.lastDuration = (now - requestStart) / 1000;
			}

			const tokPerSec = tokSamples.length > 0 ? tokSamples.reduce((a, b) => a + b, 0) / tokSamples.length : 0;

			const snapshot: PromptSnapshot = {
				promptNum,
				contextTokens: state.contextTokens ?? 0,
				contextWindow: state.contextWindow,
				inputTokens: promptInput,
				outputTokens: promptOutput,
				cacheReadTokens: promptCacheRead,
				cacheWriteTokens: promptCacheWrite,
				cost: promptCost,
				turns: promptTurns,
				tokPerSec,
				duration: state.lastDuration ?? 0,
				compacted: compactionPending,
			};
			compactionPending = false;

			state.history.push(snapshot);
			const max = Math.max(1, state.options.historyRows);
			while (state.history.length > max) state.history.shift();

			return snapshot;
		},

		/** Flag the next snapshot as post-compaction (growth series restarts). */
		markCompacted(): void {
			compactionPending = true;
		},

		startSubagent(toolCallId: string, args: unknown, now: number): SubagentInfo {
			const { agentName, tools } = parseSpawnArgs(args);
			const info: SubagentInfo = {
				toolCallId,
				agentName,
				tools,
				model: undefined,
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				contextTokens: 0,
				cost: 0,
				status: "running",
				promptNum,
				startTime: now,
				duration: 0,
				tokPerSec: 0,
			};
			byToolCallId.set(toolCallId, info);
			state.subagents.push(info);
			return info;
		},

		updateSubagent(toolCallId: string, payload: unknown): void {
			const info = byToolCallId.get(toolCallId);
			if (!info) return;
			applySubagentPatch(info, parseSubagentPayload(payload), false);
		},

		endSubagent(toolCallId: string, isError: boolean, payload: unknown, now: number): void {
			const info = byToolCallId.get(toolCallId);
			if (!info) return;
			info.status = isError ? "error" : "done";
			// Apply the authoritative final usage first, so duration and tok/s are
			// derived from the complete numbers rather than the last partial update.
			applySubagentPatch(info, parseSubagentPayload(payload), true);
			info.duration = (now - info.startTime) / 1000;
			if (info.duration > 0) info.tokPerSec = info.outputTokens / info.duration;
		},

		clearHistory(): void {
			state.history.length = 0;
		},
	};

	return state;
}
