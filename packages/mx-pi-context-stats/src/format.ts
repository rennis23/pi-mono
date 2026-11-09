/**
 * Pure display formatters.
 *
 * Every function here is total: any input (NaN, Infinity, undefined, negative)
 * produces a printable string instead of throwing or leaking "NaN" into the
 * widget, because a render that throws would take down the whole TUI.
 */

/** Compact token count: 812 → "812", 8123 → "8.1k", 812_345 → "812k". */
export function fmt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	const sign = n < 0 ? "-" : "";
	if (abs < 1000) return `${sign}${Math.round(abs)}`;
	if (abs < 100_000) return `${sign}${(abs / 1000).toFixed(1)}k`;
	return `${sign}${Math.round(abs / 1000)}k`;
}

/** Humanize duration: 5.2 → "5.2s", 65.2 → "1m 5.2s". */
export function fmtDuration(secs: number): string {
	if (!Number.isFinite(secs) || secs <= 0) return "0.0s";
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}m ${s.toFixed(1)}s`;
}

/**
 * Adaptive cost precision: sub-cent costs need 4 decimals to be non-zero,
 * while dollar-scale totals only need 2.
 */
export function fmtCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.000";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/** Context usage percentage: (82000, 128000) → "64.1%". Returns "?%" when unknown. */
export function fmtPct(tokens: number, window: number): string {
	if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return "?%";
	const pct = (Math.max(0, tokens) / window) * 100;
	return `${pct.toFixed(1)}%`;
}

/** Burn rate for the widget's health row: 1180 → "1.2k/min". */
export function fmtRate(perMinute: number): string {
	return `${fmt(perMinute)}/min`;
}

/**
 * Shorten a model id for the narrow subagent row:
 * "anthropic/claude-sonnet-4-5" → "sonnet-4-5".
 */
export function shortModel(model: string | undefined): string {
	if (!model) return "?";
	const tail = model.split("/").pop() ?? model;
	return tail.replace(/^claude-/, "");
}

/**
 * Compact tool list for the subagent row. Keeps the row inside the terminal
 * width by summarizing the tail: 5 tools at max 4 → "a,b,c+2".
 */
export function compactTools(tools: string[], max = 4): string {
	if (!Array.isArray(tools) || tools.length === 0) return "";
	const limit = Math.max(1, max);
	if (tools.length <= limit) return tools.join(",");
	const shown = limit - 1;
	return `${tools.slice(0, shown).join(",")}+${tools.length - shown}`;
}
