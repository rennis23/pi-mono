/**
 * Widget and status rendering.
 *
 * `buildWidgetLines` is pure: given state, width, a theme and options it returns
 * the lines to draw. It never touches pi types beyond the theme's `fg`, so the
 * layout can be asserted in tests with a theme that echoes plain text.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { compactTools, fmt, fmtCost, fmtDuration, fmtPct, fmtRate, shortModel } from "./format.js";
import { burnPerMinute, cacheHitRatio, promptsRemaining } from "./health.js";
import type { ContextStatsOptions } from "./options.js";
import type { PromptSnapshot, SubagentInfo } from "./types.js";

/** The minimal theme surface used by the renderer. */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
}

export interface WidgetInput {
	history: PromptSnapshot[];
	subagents: SubagentInfo[];
	options: ContextStatsOptions;
	width: number;
	theme: ThemeLike;
}

export interface StatusInput {
	lastTokPerSec: number | undefined;
	lastDuration: number | undefined;
	contextTokens: number | null;
	contextWindow: number;
}

export interface SummaryInput {
	history: PromptSnapshot[];
	subagents: SubagentInfo[];
}

/**
 * Render the widget. Returns `[]` when there is nothing to show (no width, no
 * history, widget hidden) so pi draws no widget row at all.
 */
export function buildWidgetLines(input: WidgetInput): string[] {
	const { history, subagents, options, width, theme } = input;
	if (width <= 0 || !options.visible) return [];

	// subagentRows 0 hides the section entirely — slice(-0) === slice(0) would
	// otherwise render every subagent plus a bogus "… N earlier" line.
	const tracked = options.showSubagents && options.subagentRows > 0 ? subagents : [];
	// Render-side window: trimming in endPrompt only bounds memory, so an
	// out-of-band historyRows change (e.g. `/mx-pi-settings rows 2`) shows up
	// immediately instead of on the next completed prompt.
	const visibleHistory = history.slice(-Math.max(1, options.historyRows));
	const hasHistory = visibleHistory.length > 0;
	const hasSubagents = tracked.length > 0;
	if (!hasHistory && !hasSubagents) return [];

	const lines: string[] = [];
	const divider = theme.fg("muted", "─".repeat(width));

	lines.push(divider);

	if (hasHistory) {
		lines.push(theme.fg("dim", "  context history"));

		for (let i = 0; i < visibleHistory.length; i++) {
			const snap = visibleHistory[i];
			const isCurrent = i === visibleHistory.length - 1;

			let line =
				theme.fg("dim", `  #${snap.promptNum}  `) +
				theme.fg(isCurrent ? "accent" : "dim", `ctx:${fmt(snap.contextTokens)}/${fmt(snap.contextWindow)}`) +
				theme.fg("dim", `  ${fmtPct(snap.contextTokens, snap.contextWindow)}`) +
				theme.fg("muted", `  ↑${fmt(snap.inputTokens)} ↓${fmt(snap.outputTokens)}`) +
				theme.fg("dim", `  ${fmtCost(snap.cost)}`) +
				theme.fg("dim", `  ${snap.turns}↩`);

			if (snap.tokPerSec > 0) line += theme.fg("dim", `  ${Math.round(snap.tokPerSec)}tok/s`);
			if (snap.duration > 0) line += theme.fg("dim", `  ${fmtDuration(snap.duration)}`);

			if (isCurrent && options.showHealth) {
				const burn = burnPerMinute(snap);
				if (burn !== undefined) line += theme.fg("dim", `  burn ${fmtRate(burn)}`);

				const remaining = promptsRemaining(history, snap.contextTokens, snap.contextWindow);
				if (remaining !== undefined) {
					line += theme.fg(remaining <= 1 ? "warning" : "dim", `  ~${remaining} left`);
				}

				const cache = cacheHitRatio(snap);
				if (cache !== undefined) line += theme.fg("dim", `  cache ${Math.round(cache * 100)}%`);
			}

			if (snap.compacted) line += theme.fg("warning", "  ⟳");
			if (isCurrent) line += theme.fg("accent", "  ←");

			lines.push(truncateToWidth(line, width));
		}
	}

	if (hasSubagents) {
		if (hasHistory) lines.push("");
		lines.push(theme.fg("dim", "  subagents"));

		const shown = options.subagentRows;
		const toShow = tracked.slice(-shown);
		if (tracked.length > shown) {
			lines.push(theme.fg("dim", `  … ${tracked.length - shown} earlier`));
		}

		for (const sa of toShow) {
			const icon =
				sa.status === "running"
					? theme.fg("warning", " ⏳")
					: sa.status === "done"
						? theme.fg("success", " ✓")
						: theme.fg("error", " ✗");

			const header =
				icon +
				" " +
				theme.fg("accent", sa.agentName) +
				theme.fg("dim", `  [${compactTools(sa.tools)}]`) +
				theme.fg("muted", `  ${shortModel(sa.model)}`);
			lines.push(truncateToWidth(header, width));

			if (sa.turns > 0 || sa.inputTokens > 0 || sa.status === "running") {
				let stats =
					theme.fg("dim", `      ${sa.turns}↩  `) +
					theme.fg("muted", `↑${fmt(sa.inputTokens)} ↓${fmt(sa.outputTokens)}`);
				if (sa.contextTokens > 0) stats += theme.fg("dim", `  ctx:${fmt(sa.contextTokens)}`);
				if (sa.cost > 0) stats += theme.fg("dim", `  ${fmtCost(sa.cost)}`);
				if (sa.tokPerSec > 0) stats += theme.fg("dim", `  ${Math.round(sa.tokPerSec)}tok/s`);
				if (sa.duration > 0) stats += theme.fg("dim", `  ${fmtDuration(sa.duration)}`);
				if (sa.status === "running") stats += theme.fg("warning", "  live");
				lines.push(truncateToWidth(stats, width));
			}
		}
	}

	lines.push(divider);

	// pi truncates the string-array form of setWidget to its own
	// MAX_WIDGET_LINES, but factory components render verbatim — so enforce the
	// same bound here to keep a tall widget from pushing the editor off-screen.
	if (lines.length > options.maxWidgetLines) {
		return [...lines.slice(0, options.maxWidgetLines - 1), theme.fg("muted", "  … more")];
	}
	return lines;
}

/**
 * Single-line text for pi's built-in footer extension-status row.
 *
 * pi's own footer already shows cumulative usage, cache, cost, context % and
 * model, so this only adds what it doesn't: live tok/s, prompt duration and the
 * current context view. Must stay single-line and un-themed: pi sanitizes status
 * text and renders it verbatim.
 */
export function buildStatusText(input: StatusInput): string | undefined {
	const parts: string[] = [];
	if (input.lastTokPerSec !== undefined && Number.isFinite(input.lastTokPerSec)) {
		parts.push(`${Math.round(input.lastTokPerSec)}tok/s`);
	}
	if (input.lastDuration !== undefined && Number.isFinite(input.lastDuration)) {
		parts.push(fmtDuration(input.lastDuration));
	}
	if (input.contextTokens !== null && input.contextWindow > 0) {
		parts.push(`ctx:${fmtPct(input.contextTokens, input.contextWindow)}`);
	}
	return parts.length > 0 ? parts.join("  ") : undefined;
}

/** Multi-line plain-text summary used by `/mx-pi-settings summary`. */
export function buildSummaryText(input: SummaryInput): string {
	const { history, subagents } = input;
	if (history.length === 0 && subagents.length === 0) {
		return "mx-pi-context-stats: nothing tracked yet";
	}

	const totals = history.reduce(
		(acc, s) => ({
			input: acc.input + s.inputTokens,
			output: acc.output + s.outputTokens,
			cost: acc.cost + s.cost,
			turns: acc.turns + s.turns,
		}),
		{ input: 0, output: 0, cost: 0, turns: 0 },
	);

	const lines = [`mx-pi-context-stats: ${history.length} prompt(s) tracked`];
	lines.push(`totals  in ${fmt(totals.input)}  out ${fmt(totals.output)}  ${totals.turns}↩  ${fmtCost(totals.cost)}`);

	const last = history[history.length - 1];
	if (last) {
		const remaining = promptsRemaining(history, last.contextTokens, last.contextWindow);
		const tail = remaining === undefined ? "" : `  ~${remaining} prompts left`;
		lines.push(
			`context ${fmt(last.contextTokens)}/${fmt(last.contextWindow)} (${fmtPct(last.contextTokens, last.contextWindow)})${tail}`,
		);
	}

	if (subagents.length > 0) {
		const done = subagents.filter((s) => s.status === "done").length;
		const running = subagents.filter((s) => s.status === "running").length;
		const errored = subagents.filter((s) => s.status === "error").length;
		const cost = subagents.reduce((sum, s) => sum + s.cost, 0);
		lines.push(
			`subagents ${subagents.length} (${done} done, ${running} running, ${errored} error)  ${fmtCost(cost)}`,
		);
	}

	return lines.join("\n");
}
