import { describe, expect, it } from "vitest";
import {
	type AgentToolDetails,
	formatResultStatus,
	type RenderTheme,
	renderCallLines,
	renderDiagnostics,
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
				{ name: "explorer", source: "bundled", trusted: true, hash: "abc123", description: "reads things" },
				{ name: "local", source: "project", trusted: false, hash: "def456", description: "gated" },
			],
			theme,
		).join("\n");
		expect(lines).toContain("trusted");
		expect(lines).toContain("gated");
		expect(lines).toContain("abc123");
	});

	it("strips control characters from roster text", () => {
		const rendered = renderRosterLines(
			[{ name: "evil\u0007", source: "project", trusted: false, hash: "h", description: "d\u001b[31m" }],
			theme,
		);
		for (const line of rendered) expect(line).not.toMatch(CONTROL);
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
