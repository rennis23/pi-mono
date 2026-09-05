import { describe, expect, it } from "vitest";
import type { ContextStatsOptions } from "./options.js";
import { DEFAULT_OPTIONS } from "./options.js";
import { createStatsState, MIN_SAMPLE_SECONDS } from "./state.js";

function makeState(overrides: Partial<ContextStatsOptions> = {}) {
	return createStatsState({ ...DEFAULT_OPTIONS, ...overrides });
}

/** Drive one full prompt: submit → N turns → agent_end. */
function runPrompt(
	state: ReturnType<typeof makeState>,
	opts: { turns?: number; outputPerTurn?: number; submitAt?: number; endAt?: number; contextTokens?: number } = {},
) {
	const turns = opts.turns ?? 1;
	const submitAt = opts.submitAt ?? 0;
	const endAt = opts.endAt ?? 10_000;
	state.beginPrompt(submitAt);
	for (let i = 0; i < turns; i++) {
		state.recordTurn({ input: 1000, output: opts.outputPerTurn ?? 500, cost: { total: 0.001 } });
	}
	return state.endPrompt({ tokens: opts.contextTokens ?? 5000, contextWindow: 128_000 }, endAt);
}

describe("createStatsState", () => {
	it("starts empty", () => {
		const state = makeState();
		expect(state.history).toHaveLength(0);
		expect(state.subagents).toHaveLength(0);
		expect(state.contextTokens).toBeNull();
		expect(state.lastTokPerSec).toBeUndefined();
		expect(state.lastDuration).toBeUndefined();
	});

	it("reset clears history, subagents and per-prompt accumulators", () => {
		const state = makeState();
		runPrompt(state);
		state.startSubagent("call-1", { agent_name: "Explore" }, 0);
		state.reset(200_000);

		expect(state.history).toHaveLength(0);
		expect(state.subagents).toHaveLength(0);
		expect(state.contextWindow).toBe(200_000);
		expect(state.contextTokens).toBeNull();

		const next = runPrompt(state);
		// Prompt numbering restarts rather than continuing from the old session.
		expect(next.promptNum).toBe(1);
	});
});

describe("prompt accounting", () => {
	it("accumulates usage across turns and snapshots on endPrompt", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.recordTurn({ input: 1000, output: 500, cacheRead: 200, cost: { total: 0.001 } });
		state.recordTurn({ input: 2000, output: 700, cacheRead: 300, cost: { total: 0.002 } });
		const snap = state.endPrompt({ tokens: 9000, contextWindow: 128_000 }, 30_000);

		expect(snap).toMatchObject({
			promptNum: 1,
			inputTokens: 3000,
			outputTokens: 1200,
			cacheReadTokens: 500,
			cost: 0.003,
			turns: 2,
			contextTokens: 9000,
			contextWindow: 128_000,
			duration: 30,
		});
	});

	it("resets per-prompt accumulators on the next prompt", () => {
		const state = makeState();
		runPrompt(state);
		const second = runPrompt(state);
		expect(second.promptNum).toBe(2);
		expect(second.turns).toBe(1);
		expect(second.inputTokens).toBe(1000);
	});

	it("measures duration from submission, not from session start", () => {
		const state = makeState();
		runPrompt(state, { submitAt: 0, endAt: 10_000 });
		const second = runPrompt(state, { submitAt: 60_000, endAt: 66_000 });
		expect(second.duration).toBe(6);
		expect(state.lastDuration).toBe(6);
	});

	it("restarts the clock on a user turn", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteUserTurn(50_000);
		const snap = state.endPrompt({ tokens: 100, contextWindow: 128_000 }, 55_000);
		expect(snap.duration).toBe(5);
	});

	it("keeps the previous window when usage reports none", () => {
		const state = makeState();
		runPrompt(state);
		state.endPrompt({ tokens: 100, contextWindow: 0 }, 1000);
		expect(state.contextWindow).toBe(128_000);
	});

	it("records null context tokens when pi cannot estimate usage", () => {
		const state = makeState();
		const snap = state.endPrompt({ tokens: null, contextWindow: 128_000 }, 1000);
		expect(state.contextTokens).toBeNull();
		expect(snap.contextTokens).toBe(0);
	});

	it("keeps only historyRows snapshots", () => {
		const state = makeState({ historyRows: 2 });
		runPrompt(state);
		runPrompt(state);
		runPrompt(state);
		expect(state.history.map((s) => s.promptNum)).toEqual([2, 3]);
	});
});

describe("tok/s sampling", () => {
	it("samples on first token → message end", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteFirstToken(1000);
		state.completeMessage(600, 3000); // 600 tokens over 2s
		expect(state.lastTokPerSec).toBe(300);
		const snap = state.endPrompt({ tokens: 100, contextWindow: 128_000 }, 3000);
		expect(snap.tokPerSec).toBe(300);
	});

	it("averages samples across turns", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteFirstToken(0);
		state.completeMessage(200, 1000); // 200 tok/s
		state.noteFirstToken(2000);
		state.completeMessage(600, 3000); // 600 tok/s
		const snap = state.endPrompt({ tokens: 100, contextWindow: 128_000 }, 3000);
		expect(snap.tokPerSec).toBe(400);
	});

	it("ignores implausibly short windows", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteFirstToken(0);
		state.completeMessage(100, MIN_SAMPLE_SECONDS * 1000 - 1);
		expect(state.lastTokPerSec).toBeUndefined();
	});

	it("ignores completion without a recorded first token", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.completeMessage(100, 5000);
		expect(state.lastTokPerSec).toBeUndefined();
	});

	it("only starts the window once per message", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteFirstToken(0);
		state.noteFirstToken(2000); // second delta of the same message
		state.completeMessage(400, 3000); // measured from t=0 → 133 tok/s
		expect(state.lastTokPerSec).toBeCloseTo(133.33, 2);
	});

	it("sets a request start when the first token beats agent_start", () => {
		const state = makeState();
		state.beginPrompt(0);
		state.noteFirstToken(500);
		state.completeMessage(100, 1500);
		const snap = state.endPrompt({ tokens: 1, contextWindow: 128_000 }, 2500);
		expect(snap.duration).toBe(2.5);
	});
});

describe("compaction", () => {
	it("flags the next snapshot and only that one", () => {
		const state = makeState();
		runPrompt(state);
		state.markCompacted();
		const after = runPrompt(state);
		const later = runPrompt(state);
		expect(after.compacted).toBe(true);
		expect(later.compacted).toBe(false);
	});
});

describe("subagents", () => {
	it("tracks start, live updates and completion", () => {
		const state = makeState();
		state.beginPrompt(0);
		const info = state.startSubagent("call-1", { agent_name: "Explore", tools: ["read"] }, 1000);
		expect(info).toMatchObject({ agentName: "Explore", tools: ["read"], status: "running", promptNum: 1 });
		expect(state.subagents).toHaveLength(1);

		state.updateSubagent("call-1", { details: { usage: { turns: 2, input: 8000, output: 1000 } } });
		state.endSubagent(
			"call-1",
			false,
			{
				details: {
					usage: { turns: 3, input: 15_000, output: 2000, totalTokens: 18_000, cost: 0.005 },
					model: "claude-sonnet-4-5",
				},
			},
			6000,
		);

		expect(info).toMatchObject({
			status: "done",
			turns: 3,
			inputTokens: 15_000,
			outputTokens: 2000,
			contextTokens: 18_000,
			cost: 0.005,
			duration: 5,
			tokPerSec: 400,
			model: "claude-sonnet-4-5",
		});
	});

	it("marks errors", () => {
		const state = makeState();
		state.startSubagent("call-2", {}, 0);
		state.endSubagent("call-2", true, undefined, 1000);
		expect(state.subagents[0].status).toBe("error");
	});

	it("ignores updates for unknown tool call ids", () => {
		const state = makeState();
		state.updateSubagent("nope", { details: { usage: { turns: 9 } } });
		state.endSubagent("nope", false, { details: { usage: { turns: 9 } } }, 1000);
		expect(state.subagents).toHaveLength(0);
	});

	it("keeps subagents across prompts within a session", () => {
		const state = makeState();
		state.startSubagent("call-1", { agent_name: "Explore" }, 0);
		runPrompt(state);
		state.clearHistory();
		expect(state.history).toHaveLength(0);
		expect(state.subagents).toHaveLength(1);
	});
});
