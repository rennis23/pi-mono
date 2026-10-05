import { type Component, colorToHex, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFrame, DEFAULT_BACKGROUND_COLOR, type FrameTheme, settingsBackground } from "./frame.js";

/** Identity theme: makes the rendered geometry easy to assert as plain text. */
function plainTheme(): FrameTheme {
	return { fg: (_color, text) => text, style: (text) => text };
}

function accentTheme(): FrameTheme {
	return { fg: (color, text) => `<${color}>${text}</${color}>`, style: (text) => text };
}

function stubChild(lines: string[], invalidate = vi.fn()): Component {
	return {
		render: () => lines,
		invalidate,
	};
}

interface BgCall {
	bg?: unknown;
}

function recordingTheme(calls: BgCall[], wrap = (text: string) => text): FrameTheme {
	return {
		fg: (_color, text) => text,
		style: (text, options) => {
			calls.push(options);
			return wrap(text);
		},
	};
}

describe("createFrame", () => {
	it("draws all four borders and pads every line to the requested width", () => {
		const frame = createFrame(stubChild(["hello", "world!"]), plainTheme(), (text) => text);
		const lines = frame.render(10);
		expect(lines).toEqual(["┌────────┐", "│hello   │", "│world!  │", "└────────┘"]);
		for (const line of lines) expect(visibleWidth(line)).toBe(10);
	});

	it("paints the borders, background included, through the theme hooks", () => {
		const frame = createFrame(stubChild([]), accentTheme(), (text) => `{${text}}`);
		expect(frame.render(4)).toEqual(["{<accent>┌──┐</accent>}", "{<accent>└──┘</accent>}"]);
	});

	it("truncates content wider than the inner width with an ellipsis", () => {
		const frame = createFrame(stubChild(["0123456789"]), plainTheme(), (text) => text);
		const line = frame.render(6)[1] ?? "";
		expect(stripTerminalSequences(line)).toBe("│012…│");
		expect(visibleWidth(line)).toBe(6);
	});

	it("keeps at least one inner column for very narrow renders", () => {
		const frame = createFrame(stubChild(["x"]), plainTheme(), (text) => text);
		expect(frame.render(1)).toEqual(["┌─┐", "│x│", "└─┘"]);
	});

	it("delegates invalidation to the child", () => {
		const invalidate = vi.fn();
		const frame = createFrame(stubChild([], invalidate), plainTheme(), (text) => text);
		frame.invalidate?.();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});

describe("settingsBackground", () => {
	it("applies the configured hex color verbatim", () => {
		const calls: BgCall[] = [];
		const theme = recordingTheme(calls, (text) => `<bg>${text}</bg>`);
		expect(settingsBackground(theme, "#123456")("row")).toBe("<bg>row</bg>");
		expect(calls).toHaveLength(1);
		expect(colorToHex(calls[0]?.bg as never)).toBe("#123456");
	});

	it('leaves the terminal background untouched for "none"', () => {
		const calls: BgCall[] = [];
		expect(settingsBackground(recordingTheme(calls), "none")("row")).toBe("row");
		expect(calls).toHaveLength(0);
	});

	it("falls back to no tint for an unparseable color", () => {
		const calls: BgCall[] = [];
		expect(
			settingsBackground(
				recordingTheme(calls, (text) => `{${text}}`),
				"not-a-color",
			)("row"),
		).toBe("row");
		expect(calls).toHaveLength(0);
	});

	it("defaults to the light red when no color is given", () => {
		const calls: BgCall[] = [];
		settingsBackground(recordingTheme(calls))("row");
		expect(colorToHex(calls[0]?.bg as never)).toBe(DEFAULT_BACKGROUND_COLOR);
	});

	it("re-asserts the background after an embedded reset", () => {
		const calls: BgCall[] = [];
		const theme: FrameTheme = {
			...recordingTheme(calls, (text) => `\u001b[48;2;1;2;3m${text}\u001b[49m`),
			getColorMode: () => "truecolor",
		};
		const painted = settingsBackground(theme, "#ffb3b3")("a\u001b[0mb");
		expect(painted).toContain("a\u001b[0m\u001b[48;");
		expect(painted.endsWith("\u001b[49m")).toBe(true);
	});
});
