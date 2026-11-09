/**
 * Derived "context health" metrics.
 *
 * All functions return `undefined` rather than a misleading number when the
 * inputs cannot support the calculation (no duration, unknown window, no growth
 * series). Callers omit the cell in that case, so the widget never shows NaN,
 * Infinity, or a meaningless "0".
 */

import type { PromptSnapshot } from "./types.js";

/** Tokens consumed per minute of wall clock for one prompt. */
export function burnPerMinute(snap: PromptSnapshot): number | undefined {
	if (!(snap.duration > 0)) return undefined;
	const total = snap.inputTokens + snap.outputTokens;
	if (!(total > 0)) return undefined;
	return total / (snap.duration / 60);
}

/** Share of prompt input served from cache, 0..1. */
export function cacheHitRatio(snap: PromptSnapshot): number | undefined {
	const denominator = snap.inputTokens + snap.cacheReadTokens;
	if (!(denominator > 0)) return undefined;
	return snap.cacheReadTokens / denominator;
}

/**
 * Mean context growth per prompt, in tokens.
 *
 * Deltas are measured between consecutive snapshots, skipping the pair that
 * spans a compaction (the post-compaction snapshot restarts the series, so its
 * delta is negative and would poison the average) and ignoring non-positive
 * deltas.
 */
export function contextGrowth(history: PromptSnapshot[]): number | undefined {
	if (history.length < 2) return undefined;
	const deltas: number[] = [];
	for (let i = 1; i < history.length; i++) {
		const current = history[i];
		if (current.compacted) continue;
		const delta = current.contextTokens - history[i - 1].contextTokens;
		if (delta > 0) deltas.push(delta);
	}
	if (deltas.length === 0) return undefined;
	return deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
}

/**
 * How many more prompts fit in the context window at the current growth rate.
 * Returns 0 when the window is already exhausted, `undefined` when there is not
 * enough history to extrapolate.
 */
export function promptsRemaining(
	history: PromptSnapshot[],
	contextTokens: number | null,
	contextWindow: number,
): number | undefined {
	if (contextTokens === null || !Number.isFinite(contextTokens)) return undefined;
	if (!(contextWindow > 0)) return undefined;
	const growth = contextGrowth(history);
	if (growth === undefined || !(growth > 0)) return undefined;
	const remaining = contextWindow - contextTokens;
	if (remaining <= 0) return 0;
	return Math.floor(remaining / growth);
}
