import { describe, expect, it } from "vitest";
import {
	type AgentToolDetails,
	formatResultStatus,
	formatSwitchNotice,
	type RenderTheme,
	renderCallLines,
	renderDiagnostics,
	renderDirectiveMessage,
	renderResultLines,
	renderRosterLines,
	resultGlyph,
} from "./render.js";
import { type RunResult, zeroUsage } from "./types.js";

/** Control characters excluding the renderer's own line separators. */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

const theme: RenderTheme = { fg: (_color, text) => text, bold: (text) => text };

function result(overrides: Partial<RunResult> = {}): RunResult {
	return {
		agent: "explorer",
		ok: true,
		partial: false,
		stopped: undefined,
		text: "found it",
		truncated: false,
		durationMs: 1200,
		turns: 3,
		usage: { ...zeroUsage(), input: 100, output: 50, cost: 0.01 },
		stopReason: "end",
		errorMessage: undefined,
		diagnostics: [],
		...overrides,
	};
}

describe("resultGlyph", () => {
	it("maps state to a glyph", () => {
		expect(resultGlyph(result())).toBe("✓");
		expect(resultGlyph(result({ ok: false, partial: true }))).toBe("◐");
		expect(resultGlyph(result({ ok: false, partial: false }))).toBe("✗");
	});
});

describe("formatResultStatus", () => {
	it("includes turns, duration and tokens", () => {
		const status = formatResultStatus(result());
		expect(status).toContain("3 turns");
		expect(status).toContain("1.2s");
		expect(status).toContain("150 tok");
		expect(status).toContain("$0.0100");
	});

	it("uses the singular for one turn", () => {
		expect(formatResultStatus(result({ turns: 1 }))).toContain("1 turn");
	});

	it("reports the stop reason when the run was cut short", () => {
		expect(formatResultStatus(result({ ok: false, stopped: "budget-turns" }))).toContain("budget-turns");
	});

	it("omits zero tokens and cost", () => {
		const status = formatResultStatus(result({ usage: zeroUsage(), turns: 0 }));
		expect(status).not.toContain("tok");
		expect(status).not.toContain("$");
	});
});

describe("renderCallLines", () => {
	it("renders a single call", () => {
		const lines = renderCallLines({ agent: "explorer", task: "find it" }, theme).join("\n");
		expect(lines).toContain("mx_pi_agent");
		expect(lines).toContain("explorer");
		expect(lines).toContain("find it");
	});

	it("renders parallel and chain modes", () => {
		expect(renderCallLines({ tasks: [1, 2] }, theme).join("\n")).toContain("parallel (2 tasks)");
		expect(renderCallLines({ chain: [1, 2, 3] }, theme).join("\n")).toContain("chain (3 steps)");
	});

	it("strips control characters from hostile arguments", () => {
		for (const line of renderCallLines({ agent: "evil\u0007", task: "task\u001b[31m" }, theme)) {
			expect(line).not.toMatch(CONTROL);
		}
	});

	it("tolerates missing arguments", () => {
		expect(() => renderCallLines({}, theme)).not.toThrow();
	});
});

describe("renderResultLines", () => {
	it("renders a refusal", () => {
		const details: AgentToolDetails = { mode: "single", results: [], diagnostics: [], refusalReason: "not approved" };
		expect(renderResultLines(details, theme).join("\n")).toContain("refused: not approved");
	});

	it("renders each result with status and preview", () => {
		const details: AgentToolDetails = {
			mode: "parallel",
			results: [result(), result({ agent: "reviewer", ok: false, errorMessage: "boom" })],
			diagnostics: [],
			refusalReason: undefined,
		};
		const lines = renderResultLines(details, theme).join("\n");
		expect(lines).toContain("explorer");
		expect(lines).toContain("reviewer");
		expect(lines).toContain("boom");
	});

	it("notes truncation", () => {
		const details: AgentToolDetails = {
			mode: "single",
			results: [result({ truncated: true })],
			diagnostics: [],
			refusalReason: undefined,
		};
		expect(renderResultLines(details, theme).join("\n")).toContain("truncated");
	});

	it("strips control characters from child output", () => {
		const details: AgentToolDetails = {
			mode: "single",
			results: [result({ text: "evil\u001b[31mred\u0007" })],
			diagnostics: [],
			refusalReason: undefined,
		};
		for (const line of renderResultLines(details, theme)) expect(line).not.toMatch(CONTROL);
	});
});

describe("renderRosterLines", () => {
	it("shows an empty state", () => {
		expect(renderRosterLines([], theme)).toEqual(["No agents found."]);
	});

	it("marks trusted and gated sources", () => {
		const lines = renderRosterLines(
			[
				{
					name: "explorer",
					kind: "append",
					source: "bundled",
					trusted: true,
					hash: "abc123",
					description: "reads things",
					delegate: false,
				},
				{
					name: "local",
					kind: "sub",
					source: "project",
					trusted: false,
					hash: "def456",
					description: "gated",
					delegate: false,
				},
			],
			theme,
		).join("\n");
		expect(lines).toContain("trusted");
		expect(lines).toContain("gated");
		expect(lines).toContain("abc123");
	});

	it("shows the delegate marker only when set", () => {
		const withDelegate = renderRosterLines(
			[{ name: "o", kind: "append", source: "bundled", trusted: true, hash: "h", description: "d", delegate: true }],
			theme,
		).join("\n");
		expect(withDelegate).toContain("⇄ delegate");

		const without = renderRosterLines(
			[
				{
					name: "o",
					kind: "append",
					source: "bundled",
					trusted: true,
					hash: "h",
					description: "d",
					delegate: false,
				},
			],
			theme,
		).join("\n");
		expect(without).not.toContain("delegate");
	});

	it("strips control characters from roster text", () => {
		const rendered = renderRosterLines(
			[
				{
					name: "evil\u0007",
					kind: "append",
					source: "project",
					trusted: false,
					hash: "h",
					description: "d\u001b[31m",
					delegate: false,
				},
			],
			theme,
		);
		for (const line of rendered) expect(line).not.toMatch(CONTROL);
	});
});

describe("renderDirectiveMessage", () => {
	it("renders details through the result renderer", () => {
		const details: AgentToolDetails = {
			mode: "pipeline",
			results: [result()],
			diagnostics: [],
			refusalReason: undefined,
		};
		const lines = renderDirectiveMessage({ content: "text", details }, theme).join("\n");
		expect(lines).toContain("mx-pi-agents directive");
		expect(lines).toContain("explorer");
	});

	it("falls back to the message content when details are missing", () => {
		expect(renderDirectiveMessage({ content: "hello" }, theme).join("\n")).toContain("hello");
	});

	it("renders a refusal", () => {
		const details: AgentToolDetails = { mode: "single", results: [], diagnostics: [], refusalReason: "nope" };
		expect(renderDirectiveMessage({ details }, theme).join("\n")).toContain("refused");
	});
});

describe("renderDiagnostics", () => {
	it("caps the number of rendered diagnostics", () => {
		const many = Array.from({ length: 25 }, (_, index) => ({
			level: "info" as const,
			message: `d${index}`,
		}));
		expect(renderDiagnostics(many, theme)).toHaveLength(10);
	});

	it("strips control characters", () => {
		for (const line of renderDiagnostics([{ level: "warning", message: "bad\u0007thing" }], theme)) {
			expect(line).not.toMatch(CONTROL);
		}
	});
});

describe("render: boundary hardening", () => {
	const theme: RenderTheme = { fg: (color, text) => `[${color}]${text}[/]`, bold: (text) => text };

	function makeResult(overrides: Partial<RunResult> = {}): RunResult {
		return {
			agent: "explorer",
			ok: true,
			partial: false,
			stopped: undefined,
			text: "",
			truncated: false,
			durationMs: 1200,
			turns: 1,
			usage: zeroUsage(),
			stopReason: undefined,
			errorMessage: undefined,
			diagnostics: [],
			...overrides,
		};
	}

	it("formatResultStatus omits zero-valued parts", () => {
		expect(formatResultStatus(makeResult({ turns: 0, durationMs: 0 }))).toBe("0.0s");
	});

	it("formatResultStatus singularizes one turn and pluralizes many", () => {
		expect(formatResultStatus(makeResult({ turns: 1 }))).toContain("1 turn ");
		expect(formatResultStatus(makeResult({ turns: 3 }))).toContain("3 turns");
		expect(formatResultStatus(makeResult({ turns: 0 }))).not.toContain("turn");
	});

	it("formatResultStatus includes tokens, cost and stopped", () => {
		const status = formatResultStatus(
			makeResult({
				turns: 2,
				durationMs: 1500,
				usage: { ...zeroUsage(), input: 10, output: 5, cost: 0.0123 },
				stopped: "budget-turns",
			}),
		);
		expect(status).toContain("2 turns");
		expect(status).toContain("1.5s");
		expect(status).toContain("15 tok");
		expect(status).toContain("$0.0123");
		expect(status).toContain("budget-turns");
	});

	it("resultGlyph maps ok, partial and failed", () => {
		expect(resultGlyph(makeResult())).toBe("✓");
		expect(resultGlyph(makeResult({ ok: false, partial: true }))).toBe("◐");
		expect(resultGlyph(makeResult({ ok: false, partial: false }))).toBe("✗");
	});

	it("renderCallLines shows parallel and chain summaries", () => {
		expect(renderCallLines({ tasks: [{}, {}] }, theme).join("\n")).toContain("parallel (2 tasks)");
		expect(renderCallLines({ chain: [{}, {}] }, theme).join("\n")).toContain("chain (2 steps)");
		expect(renderCallLines({ tasks: [], chain: [] }, theme).join("\n")).not.toContain("parallel");
	});

	it("renderCallLines defaults agent and sanitizes control characters", () => {
		expect(renderCallLines({}, theme)[0]).toContain("(none)");
		const lines = renderCallLines({ agent: "a\u0007b", task: "t\u0007t" }, theme);
		expect(lines[0]).not.toContain("\u0007");
		expect(lines[1]).not.toContain("\u0007");
	});

	it("renderResultLines refuses with the default reason", () => {
		const lines = renderResultLines(
			{ mode: "single", results: [], diagnostics: [], refusalReason: undefined },
			theme,
		);
		expect(lines).toEqual(["[error]refused: no results[/]"]);
	});

	it("renderResultLines renders glyph, name, status, preview, error and truncation", () => {
		const details: AgentToolDetails = {
			mode: "single",
			results: [makeResult({ agent: "a", text: "hello", errorMessage: "boom\u0007", truncated: true })],
			diagnostics: [],
			refusalReason: undefined,
		};
		const joined = renderResultLines(details, theme).join("\n");
		expect(joined).toContain("[success]✓[/]");
		expect(joined).toContain("hello");
		expect(joined).toContain("boom");
		expect(joined).not.toContain("\u0007");
		expect(joined).toContain("(output truncated)");
	});

	it("renderResultLines omits the preview for empty text", () => {
		const details: AgentToolDetails = {
			mode: "single",
			results: [makeResult({ text: "" })],
			diagnostics: [],
			refusalReason: undefined,
		};
		expect(renderResultLines(details, theme)).toHaveLength(1);
	});

	it("renderResultLines colors partial and failed results", () => {
		const partial: AgentToolDetails = {
			mode: "single",
			results: [makeResult({ ok: false, partial: true })],
			diagnostics: [],
			refusalReason: undefined,
		};
		expect(renderResultLines(partial, theme).join("\n")).toContain("[warning]◐[/]");
		const failed: AgentToolDetails = {
			mode: "single",
			results: [makeResult({ ok: false })],
			diagnostics: [],
			refusalReason: undefined,
		};
		expect(renderResultLines(failed, theme).join("\n")).toContain("[error]✗[/]");
	});

	it("renderDirectiveMessage falls back to content or header only", () => {
		expect(renderDirectiveMessage({ content: "hi\u0007" }, theme).join("\n")).toContain("hi");
		expect(renderDirectiveMessage({}, theme)).toEqual(["[toolTitle]mx-pi-agents directive[/]"]);
		expect(renderDirectiveMessage({ content: 5 }, theme)).toEqual(["[toolTitle]mx-pi-agents directive[/]"]);
	});

	it("renderDirectiveMessage renders details when present", () => {
		const details: AgentToolDetails = {
			mode: "single",
			results: [makeResult()],
			diagnostics: [],
			refusalReason: undefined,
		};
		expect(renderDirectiveMessage({ details }, theme).join("\n")).toContain("✓");
	});

	it("renderRosterLines reports none and renders trusted/gated rows", () => {
		expect(renderRosterLines([], theme)).toEqual(["No agents found."]);
		const joined = renderRosterLines(
			[
				{
					name: "a",
					kind: "replace",
					source: "global",
					trusted: true,
					hash: "abc",
					description: "d",
					delegate: false,
				},
				{
					name: "b",
					kind: "sub",
					source: "project",
					trusted: false,
					hash: "def",
					description: "e",
					delegate: false,
				},
			],
			theme,
		).join("\n");
		expect(joined).toContain("trusted");
		expect(joined).toContain("gated");
		expect(joined).toContain("[replace]");
		expect(joined).toContain("d");
	});

	it("formatSwitchNotice handles base and named modes", () => {
		expect(formatSwitchNotice("x", "base")).toBe("reset to plain pi");
		expect(formatSwitchNotice("x", "replace")).toBe("switched to replace x");
		expect(formatSwitchNotice("x", "append")).toBe("switched to append x");
	});

	it("renderDiagnostics caps at 10 and colors by level", () => {
		const many = Array.from({ length: 12 }, (_, index) => ({ level: "info" as const, message: `m${index}` }));
		expect(renderDiagnostics(many, theme)).toHaveLength(10);
		const joined = renderDiagnostics(
			[
				{ level: "error", message: "e" },
				{ level: "warning", message: "w" },
				{ level: "info", message: "i" },
			],
			theme,
		).join("\n");
		expect(joined).toContain("[error]error: e[/]");
		expect(joined).toContain("[warning]warning: w[/]");
		expect(joined).toContain("[dim]info: i[/]");
	});
});

describe("render: survivor kills", () => {
	it("ignores an empty chain array", () => {
		const lines = renderCallLines({ chain: [], agent: "explorer", task: "t" }, theme);
		expect(lines.join("\n")).not.toContain("chain (");
		expect(lines[1]).toContain("t");
	});

	it("labels the chain with its step count", () => {
		expect(renderCallLines({ chain: [1, 2] }, theme)[0]).toContain("chain (2 steps)");
	});

	it("reports no agents for an empty roster", () => {
		expect(renderRosterLines([], theme)).toEqual(["No agents found."]);
	});

	it("includes source and hash in a roster line", () => {
		const lines = renderRosterLines(
			[
				{
					name: "a",
					kind: "append",
					source: "bundled",
					trusted: true,
					hash: "abc123",
					description: "d",
					delegate: false,
				},
			],
			theme,
		);
		expect(lines[0]).toContain("bundled");
		expect(lines[0]).toContain("abc123");
	});
});
