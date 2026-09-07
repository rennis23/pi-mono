/**
 * Runtime options for mx-pi-context-stats.
 *
 * Options are plain data (no pi types) so they can be validated and tested
 * without loading pi. They are persisted in the extension's config file
 * (`<agentDir>/extensions/mx-pi-context-stats.json`) and edited via the
 * `/mx-pi-settings` command; the widget re-reads them on every render.
 */

import type { StatsPlacement } from "./types.js";

export interface ContextStatsOptions {
	/** Rolling window of completed prompts kept for the history section. */
	historyRows: number;
	/** Max subagents rendered per frame (each row is 2 lines). */
	subagentRows: number;
	/** Hard cap on widget height; matches pi's MAX_WIDGET_LINES. */
	maxWidgetLines: number;
	/** Render the subagent section. No-op when no subagent was ever seen. */
	showSubagents: boolean;
	/** Render burn rate / projection / cache ratio rows. */
	showHealth: boolean;
	/** Master switch toggled by `/mx-pi-settings toggle`. */
	visible: boolean;
	placement: StatsPlacement;
	/**
	 * Tool names treated as subagent spawners. Any tool whose name is listed
	 * here is tracked; payloads are parsed tolerantly, so unrelated tools that
	 * share a name degrade to an empty stats row instead of breaking.
	 */
	subagentToolNames: string[];
}

export const DEFAULT_OPTIONS: ContextStatsOptions = {
	historyRows: 5,
	subagentRows: 4,
	maxWidgetLines: 10,
	showSubagents: true,
	showHealth: true,
	visible: true,
	placement: "belowEditor",
	subagentToolNames: ["spawn_subagent"],
};

export const HISTORY_ROWS_MIN = 1;
export const HISTORY_ROWS_MAX = 20;
export const SUBAGENT_ROWS_MIN = 0;
export const SUBAGENT_ROWS_MAX = 20;

/**
 * Coerce an arbitrary value (typically a `/mx-pi-settings rows <n>` argument) into a
 * bounded integer, falling back to `fallback` when it is not a finite number.
 */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Merge a partial override into options, validating the numeric bounds.
 * Unknown keys are ignored, so a malformed command argument can never put the
 * widget into an unrenderable state.
 */
export function withOptions(current: ContextStatsOptions, patch: Partial<ContextStatsOptions>): ContextStatsOptions {
	const next: ContextStatsOptions = { ...current };
	if (patch.historyRows !== undefined) {
		next.historyRows = clampInt(patch.historyRows, HISTORY_ROWS_MIN, HISTORY_ROWS_MAX, current.historyRows);
	}
	if (patch.subagentRows !== undefined) {
		next.subagentRows = clampInt(patch.subagentRows, SUBAGENT_ROWS_MIN, SUBAGENT_ROWS_MAX, current.subagentRows);
	}
	if (patch.maxWidgetLines !== undefined) {
		next.maxWidgetLines = clampInt(patch.maxWidgetLines, 2, 40, current.maxWidgetLines);
	}
	if (patch.showSubagents !== undefined) next.showSubagents = Boolean(patch.showSubagents);
	if (patch.showHealth !== undefined) next.showHealth = Boolean(patch.showHealth);
	if (patch.visible !== undefined) next.visible = Boolean(patch.visible);
	if (patch.placement !== undefined) next.placement = patch.placement;
	if (patch.subagentToolNames !== undefined) {
		next.subagentToolNames = patch.subagentToolNames.filter((name) => typeof name === "string" && name.length > 0);
	}
	return next;
}
