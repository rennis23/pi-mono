/**
 * TUI rendering for `mx_pi_agent` calls and results.
 *
 * Every string that originates from a definition or a child session goes
 * through `sanitizeUiText` first: a hostile agent name or a child that prints
 * terminal escapes must not be able to drive the parent's terminal.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { sanitizeUiText } from "./security.js";
import type { AgentDiagnostic, RunResult } from "./types.js";

/** Minimal theme surface used by the renderer (keeps this module pi-free). */
export interface RenderTheme {
	fg: (color: ThemeColor, text: string) => string;
	bold?: (text: string) => string;
}

/** Structured details attached to a `mx_pi_agent` tool result. */
export interface AgentToolDetails {
	mode: "single" | "parallel" | "chain";
	results: RunResult[];
	diagnostics: AgentDiagnostic[];
	/** Set when the call was refused before any session was created. */
	refusalReason: string | undefined;
}

/** One-line status for a result, e.g. `✓ explorer 3 turns 1.2s`. */
export function formatResultStatus(result: RunResult): string {
	const parts: string[] = [];
	if (result.turns > 0) parts.push(`${result.turns} turn${result.turns === 1 ? "" : "s"}`);
	parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
	const tokens = result.usage.input + result.usage.output;
	if (tokens > 0) parts.push(`${tokens} tok`);
	if (result.usage.cost > 0) parts.push(`$${result.usage.cost.toFixed(4)}`);
	if (result.stopped !== undefined) parts.push(result.stopped);
	return parts.join(" ");
}

/** Glyph for a result. */
export function resultGlyph(result: RunResult): string {
	if (result.ok) return "✓";
	if (result.partial) return "◐";
	return "✗";
}

/** Colour for a result: success, warning for partial, error otherwise. */
function resultColor(result: RunResult): ThemeColor {
	if (result.ok) return "success";
	return result.partial ? "warning" : "error";
}

/** Colour for a diagnostic level. */
function diagnosticColor(level: AgentDiagnostic["level"]): ThemeColor {
	if (level === "error") return "error";
	return level === "warning" ? "warning" : "dim";
}

/** Render the collapsed call line. */
export function renderCallLines(
	args: { agent?: string; task?: string; tasks?: unknown[]; chain?: unknown[] },
	theme: RenderTheme,
): string[] {
	const title = theme.fg("toolTitle", "mx_pi_agent");
	if (Array.isArray(args.tasks) && args.tasks.length > 0) {
		return [`${title} ${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`];
	}
	if (Array.isArray(args.chain) && args.chain.length > 0) {
		return [`${title} ${theme.fg("accent", `chain (${args.chain.length} steps)`)}`];
	}
	const agent = sanitizeUiText(args.agent ?? "(none)", 64);
	const task = sanitizeUiText(args.task ?? "", 80);
	return [`${title} ${theme.fg("accent", agent)}`, `  ${theme.fg("dim", task)}`];
}

/** Render the collapsed result view. */
export function renderResultLines(details: AgentToolDetails, theme: RenderTheme): string[] {
	if (details.results.length === 0) {
		const reason = details.refusalReason ?? "no results";
		return [theme.fg("error", `refused: ${sanitizeUiText(reason, 120)}`)];
	}
	const lines: string[] = [];
	for (const result of details.results) {
		const glyph = resultGlyph(result);
		const color = resultColor(result);
		const name = sanitizeUiText(result.agent, 64);
		lines.push(
			`${theme.fg(color, glyph)} ${theme.fg("accent", name)} ${theme.fg("dim", formatResultStatus(result))}`,
		);
		const preview = sanitizeUiText(result.text, 200);
		if (preview.length > 0) lines.push(`  ${theme.fg("toolOutput", preview)}`);
		if (result.errorMessage !== undefined) {
			lines.push(`  ${theme.fg("error", sanitizeUiText(result.errorMessage, 200))}`);
		}
		if (result.truncated) lines.push(`  ${theme.fg("warning", "(output truncated)")}`);
	}
	return lines;
}

/** Render the roster shown by `/mx-pi-agents list`. */
export interface RosterLine {
	name: string;
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
			`${theme.fg("accent", sanitizeUiText(entry.name, 64))} ${theme.fg("dim", `[${entry.source} ${entry.hash}]`)} ${trust}`,
		);
		lines.push(`  ${theme.fg("dim", sanitizeUiText(entry.description, 120))}`);
	}
	return lines;
}

/** Text summary of diagnostics, capped and sanitized. */
export function renderDiagnostics(diagnostics: readonly AgentDiagnostic[], theme: RenderTheme): string[] {
	return diagnostics.slice(0, 10).map((diagnostic) => {
		const color = diagnosticColor(diagnostic.level);
		return theme.fg(color, sanitizeUiText(`${diagnostic.level}: ${diagnostic.message}`, 200));
	});
}
