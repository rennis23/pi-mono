import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ContextStatsOptions } from "./options.js";
import { DEFAULT_OPTIONS } from "./options.js";
import type { PromptSnapshot, SubagentInfo } from "./types.js";
import { buildStatusText, buildSummaryText, buildWidgetLines } from "./widget.js";

/** Theme that echoes plain text, so assertions can ignore ANSI codes. */
const theme = { fg: (_color: ThemeColor, text: string) => text };

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

function subagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
	return {
		toolCallId: "call-1",
		agentName: "Explore",
		tools: ["read", "grep"],
		model: "anthropic/claude-sonnet-4-5",
		turns: 2,
		inputTokens: 8000,
		outputTokens: 1000,
		contextTokens: 10_000,
		cost: 0.004,
		status: "running",
		promptNum: 1,
		startTime: 0,
		duration: 0,
		tokPerSec: 0,
		...overrides,
	};
}

function render(
	overrides: {
		history?: PromptSnapshot[];
		subagents?: SubagentInfo[];
		options?: Partial<ContextStatsOptions>;
		width?: number;
	} = {},
): string[] {
	return buildWidgetLines({
		history: overrides.history ?? [],
		subagents: overrides.subagents ?? [],
		options: { ...DEFAULT_OPTIONS, ...overrides.options },
		width: overrides.width ?? 100,
		theme,
	});
}

describe("buildWidgetLines - empty states", () => {
	it("returns no lines when there is nothing to show", () => {
		expect(render()).toEqual([]);
	});

	it("returns no lines at zero or negative width", () => {
		expect(render({ history: [snap()], width: 0 })).toEqual([]);
		expect(render({ history: [snap()], width: -5 })).toEqual([]);
	});

	it("returns no lines when the widget is hidden", () => {
		expect(render({ history: [snap()], options: { visible: false } })).toEqual([]);
	});
});

describe("buildWidgetLines - history", () => {
	it("renders a framed context history section", () => {
		const lines = render({ history: [snap()] });
		expect(lines[0]).toBe("─".repeat(100));
		expect(lines[1]).toBe("  context history");
		expect(lines[2]).toContain("#1");
		expect(lines[2]).toContain("ctx:8.0k/128k");
		expect(lines[2]).toContain("6.3%");
		expect(lines[2]).toContain("↑5.0k ↓1.0k");
		expect(lines[2]).toContain("$0.003");
		expect(lines[2]).toContain("3↩");
		// Current row is marked, and the frame is closed.
		expect(lines[2]).toContain("←");
		expect(lines.at(-1)).toBe("─".repeat(100));
	});

	it("marks only the newest row as current", () => {
		const lines = render({
			history: [snap({ promptNum: 1 }), snap({ promptNum: 2, contextTokens: 82_000 })],
			width: 160,
		});
		expect(lines[2]).not.toContain("←");
		expect(lines[3]).toContain("←");
	});

	it("renders a compaction marker", () => {
		const lines = render({ history: [snap({ compacted: true })] });
		expect(lines[2]).toContain("⟳");
	});

	it("omits tok/s and duration when unmeasured", () => {
		const lines = render({ history: [snap({ tokPerSec: 0, duration: 0 })] });
		expect(lines[2]).not.toContain("tok/s");
	});
});

describe("buildWidgetLines - health row", () => {
	const history = [
		snap({ promptNum: 1, contextTokens: 8000 }),
		snap({ promptNum: 2, contextTokens: 18_000, cacheReadTokens: 7000, inputTokens: 3000 }),
	];

	it("adds burn rate, projection and cache ratio to the current row", () => {
		const line = render({ history, width: 160 })[3];
		expect(line).toContain("burn");
		expect(line).toMatch(/~11 left/); // (128k - 18k) / 10k growth
		expect(line).toContain("cache 70%");
	});

	it("omits health cells when disabled", () => {
		const line = render({ history, width: 160, options: { showHealth: false } })[3];
		expect(line).not.toContain("burn");
		expect(line).not.toContain("cache");
	});

	it("never renders NaN when metrics are unavailable", () => {
		const line = render({ history: [snap({ duration: 0, tokPerSec: 0 })] })[2];
		expect(line).not.toContain("NaN");
		expect(line).not.toContain("undefined");
	});
});

describe("buildWidgetLines - subagents", () => {
	it("renders a running subagent with a stats row", () => {
		const lines = render({ subagents: [subagent()] });
		expect(lines[1]).toBe("  subagents");
		expect(lines[2]).toContain("⏳");
		expect(lines[2]).toContain("Explore");
		expect(lines[2]).toContain("[read,grep]");
		expect(lines[2]).toContain("sonnet-4-5");
		expect(lines[3]).toContain("live");
	});

	it("renders done and error icons", () => {
		expect(render({ subagents: [subagent({ status: "done" })] })[2]).toContain("✓");
		expect(render({ subagents: [subagent({ status: "error" })] })[2]).toContain("✗");
	});

	it("trims older subagents and reports the hidden count", () => {
		const subs = [
			subagent({ toolCallId: "a", agentName: "first" }),
			subagent({ toolCallId: "b", agentName: "second" }),
			subagent({ toolCallId: "c", agentName: "third" }),
		];
		const lines = render({ subagents: subs, options: { subagentRows: 1 } });
		expect(lines.join("\n")).toContain("… 2 earlier");
		expect(lines.join("\n")).toContain("third");
		expect(lines.join("\n")).not.toContain("first");
	});

	it("hides the section entirely when subagentRows is 0", () => {
		const subs = [subagent({ toolCallId: "a" }), subagent({ toolCallId: "b" })];
		const lines = render({ subagents: subs, options: { subagentRows: 0 } });
		expect(lines).toEqual([]);
	});

	it("hides the section when disabled", () => {
		const lines = render({ subagents: [subagent()], options: { showSubagents: false } });
		expect(lines).toEqual([]);
	});

	it("keeps the history section when subagents are disabled", () => {
		const lines = render({
			history: [snap()],
			subagents: [subagent()],
			options: { showSubagents: false },
		});
		expect(lines.join("\n")).toContain("context history");
		expect(lines.join("\n")).not.toContain("subagents");
	});

	it("shows an unknown model as ?", () => {
		expect(render({ subagents: [subagent({ model: undefined })] })[2]).toContain("  ?");
	});
});

describe("buildWidgetLines - layout guards", () => {
	it("caps height and appends a more row", () => {
		const history = Array.from({ length: 5 }, (_, i) => snap({ promptNum: i + 1 }));
		const lines = render({ history, options: { maxWidgetLines: 6 } });
		expect(lines).toHaveLength(6);
		expect(lines.at(-1)).toBe("  … more");
	});

	it("truncates every line to the terminal width", () => {
		const lines = render({ history: [snap()], subagents: [subagent()], width: 24 });
		for (const line of lines) {
			// Raw length can exceed the width because truncateToWidth's ellipsis is
			// wrapped in ANSI reset codes; display width is what matters.
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});
});

describe("buildStatusText", () => {
	it("joins tok/s, duration and context", () => {
		expect(
			buildStatusText({ lastTokPerSec: 42.4, lastDuration: 65.2, contextTokens: 8000, contextWindow: 128_000 }),
		).toBe("42tok/s  1m 5.2s  ctx:6.3%");
	});

	it("omits missing parts", () => {
		expect(
			buildStatusText({ lastTokPerSec: undefined, lastDuration: 5, contextTokens: null, contextWindow: 0 }),
		).toBe("5.0s");
	});

	it("returns undefined when there is nothing to report", () => {
		expect(
			buildStatusText({ lastTokPerSec: undefined, lastDuration: undefined, contextTokens: null, contextWindow: 0 }),
		).toBeUndefined();
	});

	it("ignores non-finite values", () => {
		expect(
			buildStatusText({
				lastTokPerSec: Number.NaN,
				lastDuration: Number.POSITIVE_INFINITY,
				contextTokens: null,
				contextWindow: 0,
			}),
		).toBeUndefined();
	});
});

describe("buildSummaryText", () => {
	it("reports an empty session", () => {
		expect(buildSummaryText({ history: [], subagents: [] })).toBe("mx-pi-context-stats: nothing tracked yet");
	});

	it("totals prompts, context and subagents", () => {
		const text = buildSummaryText({
			history: [snap({ promptNum: 1 }), snap({ promptNum: 2, contextTokens: 18_000 })],
			subagents: [subagent({ status: "done" }), subagent({ toolCallId: "b", status: "running" })],
		});
		expect(text).toContain("2 prompt(s) tracked");
		expect(text).toContain("in 10.0k  out 2.0k");
		expect(text).toContain("context 18.0k/128k (14.1%)");
		expect(text).toContain("subagents 2 (1 done, 1 running, 0 error)");
	});
});
