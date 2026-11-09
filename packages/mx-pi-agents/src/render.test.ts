import { describe, expect, it } from "vitest";
import {
	formatSwitchNotice,
	type RenderTheme,
	renderDiagnostics,
	renderDirectiveMessage,
	renderRosterLines,
} from "./render.js";

/** Control characters excluding the renderer's own line separators. */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

const theme: RenderTheme = { fg: (_color, text) => text, bold: (text) => text };
const coloredTheme: RenderTheme = { fg: (color, text) => `[${color}]${text}[/]`, bold: (text) => text };

function rosterLine(overrides: Partial<Parameters<typeof renderRosterLines>[0][number]> = {}) {
	return {
		name: "explorer",
		mode: "append" as const,
		source: "bundled",
		trusted: true,
		hash: "abc123",
		description: "reads things",
		...overrides,
	};
}

describe("renderRosterLines", () => {
	it("shows an empty state", () => {
		expect(renderRosterLines([], theme)).toEqual(["No agents found."]);
	});

	it("marks trusted and gated sources and includes mode, source and hash", () => {
		const lines = renderRosterLines(
			[
				rosterLine({ name: "explorer", mode: "replace", source: "bundled", trusted: true, hash: "abc123" }),
				rosterLine({ name: "local", mode: "append", source: "project", trusted: false, hash: "def456" }),
			],
			theme,
		).join("\n");
		expect(lines).toContain("trusted");
		expect(lines).toContain("gated");
		expect(lines).toContain("[replace]");
		expect(lines).toContain("[append]");
		expect(lines).toContain("abc123");
		expect(lines).toContain("def456");
		expect(lines).toContain("reads things");
	});

	it("strips control characters from roster text", () => {
		const rendered = renderRosterLines([rosterLine({ name: "evil\u0007", description: "d\u001b[31m" })], theme);
		for (const line of rendered) expect(line).not.toMatch(CONTROL);
	});
});

describe("formatSwitchNotice", () => {
	it("handles base and each mode", () => {
		expect(formatSwitchNotice("x", "base")).toBe("reset to plain pi");
		expect(formatSwitchNotice("x", "replace")).toBe("switched to replace persona x");
		expect(formatSwitchNotice("x", "append")).toBe("switched to append persona x");
	});

	it("sanitizes the name", () => {
		expect(formatSwitchNotice("evil\u0007", "append")).toBe("switched to append persona evil");
	});
});

describe("renderDirectiveMessage", () => {
	it("renders the header plus sanitized content", () => {
		const lines = renderDirectiveMessage({ content: "hi\u0007" }, coloredTheme);
		expect(lines[0]).toBe("[toolTitle]mx-pi-agents directive[/]");
		expect(lines.join("\n")).toContain("hi");
		expect(lines.join("\n")).not.toMatch(CONTROL);
	});

	it("renders the header only for missing or non-string content", () => {
		expect(renderDirectiveMessage({}, coloredTheme)).toEqual(["[toolTitle]mx-pi-agents directive[/]"]);
		expect(renderDirectiveMessage({ content: 5 }, coloredTheme)).toEqual(["[toolTitle]mx-pi-agents directive[/]"]);
	});
});

describe("renderDiagnostics", () => {
	it("caps the number of rendered diagnostics", () => {
		const many = Array.from({ length: 25 }, (_, index) => ({ level: "info" as const, message: `d${index}` }));
		expect(renderDiagnostics(many, theme)).toHaveLength(10);
	});

	it("colors by level", () => {
		const joined = renderDiagnostics(
			[
				{ level: "error", message: "e" },
				{ level: "warning", message: "w" },
				{ level: "info", message: "i" },
			],
			coloredTheme,
		).join("\n");
		expect(joined).toContain("[error]error: e[/]");
		expect(joined).toContain("[warning]warning: w[/]");
		expect(joined).toContain("[dim]info: i[/]");
	});

	it("strips control characters and caps the message length", () => {
		const lines = renderDiagnostics([{ level: "warning", message: `${"x".repeat(300)}\u0007` }], theme);
		expect(lines[0]).not.toMatch(CONTROL);
		expect(lines[0].length).toBeLessThanOrEqual(200);
	});
});
