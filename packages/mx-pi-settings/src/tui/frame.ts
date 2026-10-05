/** Full-box frame and background used by the settings overlay. */

import type { Component, TextStyle } from "@earendil-works/pi-tui";
import { backgroundAnsi, parseColor, truncateToWidth } from "@earendil-works/pi-tui";
import { NO_COLOR } from "../fields.js";

/**
 * The slice of pi's theme the frame needs. Kept structural (instead of importing `Theme`)
 * so tests can pass a tiny stub without constructing a full theme.
 */
export interface FrameTheme {
	/** Style the border glyphs. */
	fg(color: string, text: string): string;
	/** Apply a concrete background color to a full line. */
	style(text: string, options: TextStyle): string;
	/** Terminal color mode, used to build the background escape sequence. */
	getColorMode?(): "256color" | "truecolor";
}

/** Overlay background used when the appearance setting has no stored value. */
export const DEFAULT_BACKGROUND_COLOR = "#ffb3b3";

/**
 * Build the overlay's background painter from a validated color value. `none`
 * leaves the terminal background untouched; any other value is a hex color
 * applied verbatim — no blending and no opacity.
 */
export function settingsBackground(
	theme: FrameTheme,
	color: string = DEFAULT_BACKGROUND_COLOR,
): (text: string) => string {
	if (color === NO_COLOR) return (text: string) => text;
	let parsed: ReturnType<typeof parseColor>;
	try {
		parsed = parseColor(color);
	} catch {
		// An unstorable value can only come from hand-edited JSON; fall back to no tint.
		return (text: string) => text;
	}
	const open = backgroundAnsi(parsed, theme.getColorMode?.() ?? "truecolor");
	// Content may contain full resets; re-assert the background so it cannot punch
	// holes in the panel color.
	return (text: string) => theme.style(text.replaceAll("\u001b[0m", `\u001b[0m${open}`), { bg: parsed });
}

/**
 * Draw a box around `child` with all four borders and paint every rendered line with
 * `background`, so the overlay reads as one visible panel instead of a floating list.
 */
export function createFrame(child: Component, theme: FrameTheme, background: (text: string) => string): Component {
	const border = (text: string) => theme.fg("accent", text);
	return {
		render(width: number): string[] {
			// Always leave room for the two vertical border columns.
			const total = Math.max(3, width);
			const inner = total - 2;
			const lines = [background(border(`┌${"─".repeat(inner)}┐`))];
			for (const line of child.render(inner)) {
				const content = truncateToWidth(line, inner, "…", true);
				lines.push(background(`${border("│")}${content}${border("│")}`));
			}
			lines.push(background(border(`└${"─".repeat(inner)}┘`)));
			return lines;
		},
		invalidate() {
			child.invalidate?.();
		},
	};
}
