/**
 * TUI rendering for roster lines, switch notices, directive messages and
 * diagnostics.
 *
 * Every string that originates from a definition goes through `sanitizeUiText`
 * first: a hostile agent name must not be able to drive the parent's terminal.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { sanitizeUiText } from "./security.js";
import type { AgentDiagnostic, SystemPromptMode } from "./types.js";

/** Minimal theme surface used by the renderer (keeps this module pi-free). */
export interface RenderTheme {
	fg: (color: ThemeColor, text: string) => string;
	bold?: (text: string) => string;
}

/** Colour for a diagnostic level. */
function diagnosticColor(level: AgentDiagnostic["level"]): ThemeColor {
	if (level === "error") return "error";
	return level === "warning" ? "warning" : "dim";
}

/** Render a `#` directive message appended to the transcript. */
export function renderDirectiveMessage(message: { content?: unknown }, theme: RenderTheme): string[] {
	const header = theme.fg("toolTitle", "mx-pi-agents directive");
	const text = typeof message.content === "string" ? message.content : "";
	return text.length > 0 ? [header, theme.fg("toolOutput", sanitizeUiText(text, 200))] : [header];
}

/** Render the roster shown by `/mx-pi-agents list`. */
export interface RosterLine {
	name: string;
	mode: SystemPromptMode;
	source: string;
	trusted: boolean;
	hash: string;
	description: string;
}

export function renderRosterLines(entries: readonly RosterLine[], theme: RenderTheme): string[] {
	if (entries.length === 0) return ["No agents found."];
	const lines: string[] = [];
	for (const entry of entries) {
		const trust = entry.trusted ? theme.fg("success", "trusted") : theme.fg("warning", "gated");
		lines.push(
			`${theme.fg("accent", sanitizeUiText(entry.name, 64))} ${theme.fg("dim", `[${entry.mode}] [${entry.source} ${entry.hash}]`)} ${trust}`,
		);
		lines.push(`  ${theme.fg("dim", sanitizeUiText(entry.description, 120))}`);
	}
	return lines;
}

/** One-line notice for a main-session switch (`replace`/`append`) or reset. */
export function formatSwitchNotice(name: string, mode: SystemPromptMode | "base"): string {
	if (mode === "base") return "reset to plain pi";
	return `switched to ${mode} persona ${sanitizeUiText(name, 64)}`;
}

/** Text summary of diagnostics, capped and sanitized. */
export function renderDiagnostics(diagnostics: readonly AgentDiagnostic[], theme: RenderTheme): string[] {
	return diagnostics.slice(0, 10).map((diagnostic) => {
		const color = diagnosticColor(diagnostic.level);
		return theme.fg(color, sanitizeUiText(`${diagnostic.level}: ${diagnostic.message}`, 200));
	});
}
