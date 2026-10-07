/**
 * mx-pi-context-stats
 *
 * Adds per-prompt context, token, cost and subagent stats to pi:
 *
 *  - a widget below the editor with a rolling prompt history and live subagent
 *    rows (including burn rate, cache ratio and a "prompts left" projection)
 *  - a single-line status entry on pi's built-in footer showing live tok/s,
 *    prompt duration and context usage
 *
 * pi's native footer is never replaced; status text is published through
 * `ctx.ui.setStatus`, which the built-in footer renders on its own row.
 *
 * User-facing options are registered with `@rennis23/mx-pi-settings`, the
 * central mx-pi settings hub. Session history remains in memory only.
 *
 * Subagent tracking is opt-in by detection: any tool listed in
 * `options.subagentToolNames` (default `spawn_subagent`) is tracked, and its
 * progress/result payloads are parsed tolerantly. When no such tool exists the
 * subagent section simply never renders — no warnings, no registration.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSettings } from "@rennis23/mx-pi-settings";
import {
	type ContextStatsOptions,
	DEFAULT_OPTIONS,
	HISTORY_ROWS_MAX,
	HISTORY_ROWS_MIN,
	SUBAGENT_ROWS_MAX,
	SUBAGENT_ROWS_MIN,
	withOptions,
} from "./src/options.js";
import { createStatsState } from "./src/state.js";
import type { StatsPlacement } from "./src/types.js";
import { buildStatusText, buildSummaryText, buildWidgetLines } from "./src/widget.js";

const STATUS_KEY = "mx-pi-context-stats";
const WIDGET_KEY = "mx-pi-context-stats";
const COMMAND_USAGE = "Usage: /mx-pi-context-stats [summary]";

interface ContextStatsSettings {
	visible: boolean;
	historyRows: number;
	subagentRows: number;
	showSubagents: boolean;
	showHealth: boolean;
	placement: StatsPlacement;
}

export default function contextStats(pi: ExtensionAPI) {
	const state = createStatsState({ ...DEFAULT_OPTIONS } as ContextStatsOptions);
	let currentCtx: ExtensionContext | undefined;

	// TUI handle captured from the widget factory, used to request redraws when
	// state changes outside of a render (streaming updates, settings changes).
	let widgetTui: { requestRender(): void } | undefined;

	function requestRender(): void {
		try {
			widgetTui?.requestRender();
		} catch {
			/* stale/disposed TUI: nothing to redraw */
		}
	}

	/**
	 * Publish the extras pi's footer does not already show. Safe in every mode:
	 * `setStatus` is a no-op outside the TUI and failures are swallowed so a
	 * disposing session can never crash a render.
	 */
	function updateStatus(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				buildStatusText({
					lastTokPerSec: state.lastTokPerSec,
					lastDuration: state.lastDuration,
					contextTokens: state.contextTokens,
					contextWindow: state.contextWindow,
				}),
			);
		} catch {
			/* stale/disposed context: ignore */
		}
	}

	function setupWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				widgetTui = tui;
				return {
					// State is read fresh on every render, so runtime option changes
					// and streaming updates show up without re-registering.
					render: (width: number) => {
						try {
							return buildWidgetLines({
								history: state.history,
								subagents: state.subagents,
								options: state.options,
								width,
								theme,
							});
						} catch (err) {
							// Rendered without the theme on purpose: if the theme is
							// what failed, calling it again would throw out of the render.
							return [`mx-pi-context-stats widget: ${err instanceof Error ? err.message : String(err)}`];
						}
					},
					invalidate: () => {},
				};
			},
			{ placement: state.options.placement },
		);
	}

	const settings = registerSettings<ContextStatsSettings>(pi, {
		id: "mx-pi-context-stats",
		title: "Context stats",
		description: "Controls the prompt history and subagent widget.",
		fields: [
			{
				key: "visible",
				label: "Widget",
				description: "Show or hide the context stats widget.",
				type: "boolean",
				default: DEFAULT_OPTIONS.visible,
			},
			{
				key: "historyRows",
				label: "History rows",
				description: "Number of completed prompt rows to retain.",
				type: "number",
				default: DEFAULT_OPTIONS.historyRows,
				min: HISTORY_ROWS_MIN,
				max: HISTORY_ROWS_MAX,
				integer: true,
			},
			{
				key: "subagentRows",
				label: "Subagent rows",
				description: "Maximum live/completed subagent rows to render.",
				type: "number",
				default: DEFAULT_OPTIONS.subagentRows,
				min: SUBAGENT_ROWS_MIN,
				max: SUBAGENT_ROWS_MAX,
				integer: true,
			},
			{
				key: "showSubagents",
				label: "Subagent section",
				description: "Show tool progress and usage for detected subagents.",
				type: "boolean",
				default: DEFAULT_OPTIONS.showSubagents,
			},
			{
				key: "showHealth",
				label: "Health metrics",
				description: "Show burn rate, projection, and cache ratio.",
				type: "boolean",
				default: DEFAULT_OPTIONS.showHealth,
			},
			{
				key: "placement",
				label: "Placement",
				description: "Choose where the widget appears relative to the editor.",
				type: "select",
				default: DEFAULT_OPTIONS.placement,
				options: [
					{ value: "aboveEditor", label: "Above editor" },
					{ value: "belowEditor", label: "Below editor" },
				],
			},
		],
		onChange(values) {
			const placementChanged = state.options.placement !== values.placement;
			state.options = withOptions(state.options, values);
			if (placementChanged && currentCtx) setupWidget(currentCtx);
			requestRender();
		},
	});

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		state.reset(ctx.model?.contextWindow ?? 0);
		// The shared SDK reads its central namespace and run flags; projecting it
		// into this extension's richer runtime options preserves private defaults.
		state.options = withOptions(state.options, settings.values());
		setupWidget(ctx);
		// Also clears any stale status text left by the previous session.
		updateStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		state.setContextWindow(event.model.contextWindow);
		updateStatus(ctx);
	});

	pi.on("agent_start", async () => {
		state.beginPrompt(Date.now());
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message;
		if (msg?.role === "user") {
			// Waiting on the user is not work: restart the prompt clock.
			state.noteUserTurn(Date.now());
			return;
		}
		if (msg?.role !== "assistant" || !msg.usage) return;
		state.recordTurn(msg.usage);
	});

	pi.on("message_update", async (event) => {
		if (event.assistantMessageEvent.type === "text_delta") {
			state.noteFirstToken(Date.now());
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		state.completeMessage(msg.usage?.output ?? 0, Date.now());
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.endPrompt(ctx.getContextUsage(), Date.now());
		updateStatus(ctx);
		requestRender();
	});

	pi.on("session_compact", async () => {
		// The next snapshot restarts the context growth series.
		state.markCompacted();
	});

	// ── Subagent tracking ────────────────────────────────────────────────────

	function isSubagentTool(toolName: string): boolean {
		return state.options.subagentToolNames.includes(toolName);
	}

	pi.on("tool_execution_start", async (event) => {
		if (!isSubagentTool(event.toolName)) return;
		state.startSubagent(event.toolCallId, event.args, Date.now());
		requestRender();
	});

	pi.on("tool_execution_update", async (event) => {
		if (!isSubagentTool(event.toolName)) return;
		state.updateSubagent(event.toolCallId, event.partialResult);
		requestRender();
	});

	pi.on("tool_execution_end", async (event) => {
		if (!isSubagentTool(event.toolName)) return;
		state.endSubagent(event.toolCallId, event.isError, event.result, Date.now());
		requestRender();
	});

	// Session summary is an action, not a setting, so it remains on this extension.
	pi.registerCommand("mx-pi-context-stats", {
		description: "Show the current session's context/token/cost summary",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command !== "" && command !== "summary") {
				ctx.ui.notify(COMMAND_USAGE, "warning");
				return;
			}
			ctx.ui.notify(buildSummaryText({ history: state.history, subagents: state.subagents }), "info");
		},
	});
}
