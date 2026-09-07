import { describe, expect, it } from "vitest";
import { burnPerMinute, cacheHitRatio, contextGrowth, promptsRemaining } from "./health.js";
import type { PromptSnapshot } from "./types.js";

function snap(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
	return {
		promptNum: 1,
		contextTokens: 8000,
		contextWindow: 128_000,
		inputTokens: 5000,
		outputTokens: 1000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0.003,
		turns: 3,
		tokPerSec: 42,
		duration: 30,
		compacted: false,
		...overrides,
	};
}

describe("burnPerMinute", () => {
	it("computes tokens per minute from duration", () => {
		// 6000 tokens over 30s → 12000/min
		expect(burnPerMinute(snap({ inputTokens: 5000, outputTokens: 1000, duration: 30 }))).toBe(12_000);
	});

	it("is undefined without a positive duration", () => {
		expect(burnPerMinute(snap({ duration: 0 }))).toBeUndefined();
		expect(burnPerMinute(snap({ duration: -5 }))).toBeUndefined();
		expect(burnPerMinute(snap({ duration: Number.NaN }))).toBeUndefined();
	});

	it("is undefined when no tokens were consumed", () => {
		expect(burnPerMinute(snap({ inputTokens: 0, outputTokens: 0 }))).toBeUndefined();
	});
});

describe("cacheHitRatio", () => {
	it("measures the cached share of input", () => {
		expect(cacheHitRatio(snap({ inputTokens: 3000, cacheReadTokens: 7000 }))).toBe(0.7);
	});

	it("is undefined when there is no input at all", () => {
		expect(cacheHitRatio(snap({ inputTokens: 0, cacheReadTokens: 0 }))).toBeUndefined();
	});

	it("returns 1 when everything was cached", () => {
		expect(cacheHitRatio(snap({ inputTokens: 0, cacheReadTokens: 9000 }))).toBe(1);
	});
});

describe("contextGrowth", () => {
	it("averages positive deltas between snapshots", () => {
		const history = [
			snap({ promptNum: 1, contextTokens: 10_000 }),
			snap({ promptNum: 2, contextTokens: 20_000 }),
			snap({ promptNum: 3, contextTokens: 36_000 }),
		];
		// deltas: 10_000 and 16_000 → mean 13_000
		expect(contextGrowth(history)).toBe(13_000);
	});

	it("is undefined with fewer than two snapshots", () => {
		expect(contextGrowth([])).toBeUndefined();
		expect(contextGrowth([snap()])).toBeUndefined();
	});

	it("skips the delta that spans a compaction", () => {
		const history = [
			snap({ promptNum: 1, contextTokens: 100_000 }),
			snap({ promptNum: 2, contextTokens: 20_000, compacted: true }),
			snap({ promptNum: 3, contextTokens: 30_000 }),
		];
		// Only the 20k → 30k delta counts; the -80k compaction delta is dropped.
		expect(contextGrowth(history)).toBe(10_000);
	});

	it("is undefined when the context never grew", () => {
		const history = [snap({ promptNum: 1, contextTokens: 30_000 }), snap({ promptNum: 2, contextTokens: 20_000 })];
		expect(contextGrowth(history)).toBeUndefined();
	});
});

describe("promptsRemaining", () => {
	const history = [snap({ promptNum: 1, contextTokens: 8000 }), snap({ promptNum: 2, contextTokens: 18_000 })];

	it("projects remaining prompts from the growth rate", () => {
		// growth 10k, remaining 128k - 18k = 110k → 11 prompts
		expect(promptsRemaining(history, 18_000, 128_000)).toBe(11);
	});

	it("returns 0 when the window is exhausted", () => {
		expect(promptsRemaining(history, 128_000, 128_000)).toBe(0);
		expect(promptsRemaining(history, 130_000, 128_000)).toBe(0);
	});

	it("is undefined without a series or a window", () => {
		expect(promptsRemaining([snap()], 18_000, 128_000)).toBeUndefined();
		expect(promptsRemaining(history, 18_000, 0)).toBeUndefined();
		expect(promptsRemaining(history, null, 128_000)).toBeUndefined();
		expect(promptsRemaining(history, Number.NaN, 128_000)).toBeUndefined();
	});
});
