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
 * Options are durable: they live in `<agentDir>/extensions/
 * mx-pi-context-stats.json` and are edited through the `/mx-pi-settings`
 * command (interactive picker or scriptable subcommands). CLI flags override
 * the file for a single run without persisting.
 *
 * Subagent tracking is opt-in by detection: any tool listed in
 * `options.subagentToolNames` (default `spawn_subagent`) is tracked, and its
 * progress/result payloads are parsed tolerantly. When no such tool exists the
 * subagent section simply never renders — no warnings, no registration.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "./src/config.js";
import {
	type ContextStatsOptions,
	clampInt,
	DEFAULT_OPTIONS,
	HISTORY_ROWS_MAX,
	HISTORY_ROWS_MIN,
	SUBAGENT_ROWS_MAX,
	SUBAGENT_ROWS_MIN,
	withOptions,
} from "./src/options.js";
import { createStatsState } from "./src/state.js";
import { buildStatusText, buildSummaryText, buildWidgetLines } from "./src/widget.js";
import { escapeHtml } from "./src/utils.js";

const STATUS_KEY = "mx-pi-context-stats";
const WIDGET_KEY = "mx-pi-context-stats";

const USAGE =
	"Usage: /mx-pi-settings [toggle|summary|rows <n>|subagent-rows <n>|subagents on|off|health on|off|placement above|below|reset]";

export default function contextStats(pi: ExtensionAPI) {
	const state = createStatsState({ ...DEFAULT_OPTIONS } as ContextStatsOptions);

	// Durable option store: read on session start, written back by /mx-pi-settings.
	// The path is resolved when the extension is set up (not at import time), so
	// PI_CODING_AGENT_DIR overrides take effect.
	const config = createConfigStore();

	/**
	 * Apply an options patch and persist the result. Save failures are surfaced
	 * as a warning but never block the in-session change.
	 */
	function updateOptions(ctx: ExtensionContext, patch: Partial<ContextStatsOptions>): void {
		state.options = withOptions(state.options, patch);
		try {
			config.save(state.options);
		} catch (err) {
			ctx.ui.notify(
				`mx-pi-settings: could not save config to ${config.path}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	}

	// TUI handle captured from the widget factory, used to request redraws when
	// state changes outside of a render (streaming updates, prompt completion).
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
							// what failed, calling it again would throw out of the
							// render and take the TUI down with it.
							return [`mx-pi-context-stats widget: ${err instanceof Error ? err.message : String(err)}`];
						}
					},
					invalidate: () => {},
				};
			},
			{ placement: state.options.placement },
		);
	}

	/** Apply CLI flag overrides (useful in print/non-interactive mode). */
	function applyFlags(): void {
		const rows = pi.getFlag("mx-pi-context-stats-rows");
		if (rows !== undefined) {
			state.options = withOptions(state.options, {
				historyRows: clampInt(rows, HISTORY_ROWS_MIN, HISTORY_ROWS_MAX, state.options.historyRows),
			});
		}
		if (pi.getFlag("mx-pi-context-stats-hide") === true) {
			state.options = withOptions(state.options, { visible: false });
		}
	}

	pi.registerFlag("mx-pi-context-stats-rows", {
		type: "string",
		description:
			"Number of prompt history rows shown by mx-pi-context-stats (overrides the config file for this run)",
	});
	pi.registerFlag("mx-pi-context-stats-hide", {
		type: "boolean",
		description: "Hide the mx-pi-context-stats widget for this run (overrides the config file)",
	});

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		state.reset(ctx.model?.contextWindow ?? 0);
		// Durable config file is the source of truth; CLI flags win for this run.
		state.options = config.resolve({ ...DEFAULT_OPTIONS } as ContextStatsOptions);
		applyFlags();
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

	// ── /mx-pi-settings command ──────────────────────────────────────────────

	/** Current option values as one line, for non-dialog modes and confirmations. */
	function describeOptions(): string {
		const o = state.options;
		return (
			`visible=${o.visible} historyRows=${o.historyRows} subagentRows=${o.subagentRows} ` +
			`subagents=${o.showSubagents} health=${o.showHealth} placement=${o.placement}`
		);
	}

	/**
	 * Interactive settings picker. Each row shows the current value; choosing
	 * one opens a follow-up dialog and persists the result. Returns without
	 * changing anything when the user dismisses a dialog (Esc).
	 */
	async function openSettingsPicker(ctx: ExtensionCommandContext): Promise<void> {
		const o = state.options;
		type Choice = { label: string; run: () => Promise<void> };

		const pickBoolean = async (title: string, key: "showSubagents" | "showHealth", on: string, off: string) => {
			const value = await ctx.ui.select(title, [on, off]);
			if (value === undefined) return;
			updateOptions(ctx, { [key]: value === on } as Partial<ContextStatsOptions>);
			requestRender();
			ctx.ui.notify(
				`mx-pi-settings ${key === "showSubagents" ? "subagents" : "health"}: ${value === on ? "on" : "off"}`,
				"info",
			);
		};

		const pickNumber = async (title: string, key: "historyRows" | "subagentRows", min: number, max: number) => {
			const raw = await ctx.ui.input(title, `${min}-${max}: ${state.options[key]}`);
			if (raw === undefined) return;
			updateOptions(ctx, { [key]: clampInt(raw, min, max, state.options[key]) } as Partial<ContextStatsOptions>);
			requestRender();
			ctx.ui.notify(`mx-pi-settings ${key}: ${state.options[key]}`, "info");
		};

		const choices: Choice[] = [
			{
				label: `Widget — ${o.visible ? "shown" : "hidden"}`,
				run: async () => {
					updateOptions(ctx, { visible: !state.options.visible });
					requestRender();
					ctx.ui.notify(`mx-pi-settings widget ${state.options.visible ? "shown" : "hidden"}`, "info");
				},
			},
			{
				label: `History rows — ${o.historyRows}`,
				run: () => pickNumber("History rows", "historyRows", HISTORY_ROWS_MIN, HISTORY_ROWS_MAX),
			},
			{
				label: `Subagent rows — ${o.subagentRows}`,
				run: () => pickNumber("Subagent rows", "subagentRows", SUBAGENT_ROWS_MIN, SUBAGENT_ROWS_MAX),
			},
			{
				label: `Subagent section — ${o.showSubagents ? "on" : "off"}`,
				run: () => pickBoolean("Subagent section", "showSubagents", "on", "off"),
			},
			{
				label: `Health metrics — ${o.showHealth ? "on" : "off"}`,
				run: () => pickBoolean("Health metrics", "showHealth", "on", "off"),
			},
			{
				label: `Placement — ${o.placement === "aboveEditor" ? "above editor" : "below editor"}`,
				run: async () => {
					const value = await ctx.ui.select("Widget placement", ["below editor", "above editor"]);
					if (value === undefined) return;
					// Placement is fixed at registration time, so persist and re-register.
					updateOptions(ctx, { placement: value === "above editor" ? "aboveEditor" : "belowEditor" });
					setupWidget(ctx);
					ctx.ui.notify(`mx-pi-settings placement: ${value}`, "info");
				},
			},
			{
				label: "Show summary",
				run: async () => {
					ctx.ui.notify(buildSummaryText({ history: state.history, subagents: state.subagents }), "info");
				},
			},
			{
				label: "Clear prompt history",
				run: async () => {
					state.clearHistory();
					requestRender();
					ctx.ui.notify("mx-pi-settings history cleared", "info");
				},
			},
		];

		const picked = await ctx.ui.select(
			"mx-pi-settings (mx-pi-context-stats)",
			choices.map((c) => c.label),
		);
		if (picked === undefined) return;
		const choice = choices.find((c) => c.label === picked);
		if (choice) await choice.run();
	}

	pi.registerCommand("mx-pi-settings", {
		description: "Configure the mx-pi-context-stats widget (persisted to its config file)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const parts = args
				.trim()
				.split(/\s+/)
				.filter((p) => p.length > 0);
			const cmd = (parts[0] ?? "").toLowerCase();
			const arg = parts[1];

			switch (cmd) {
				case "": {
					if (ctx.hasUI) {
						await openSettingsPicker(ctx);
						return;
					}
					// No dialog UI (print/json mode): report instead of hanging.
					ctx.ui.notify(`mx-pi-settings ${describeOptions()}. ${USAGE}`, "info");
					return;
				}

				case "toggle": {
					updateOptions(ctx, { visible: !state.options.visible });
					ctx.ui.notify(`mx-pi-settings widget ${state.options.visible ? "shown" : "hidden"}`, "info");
					requestRender();
					return;
				}

				case "summary": {
					ctx.ui.notify(buildSummaryText({ history: state.history, subagents: state.subagents }), "info");
					return;
				}

				case "rows":
				case "subagent-rows": {
					const key = cmd === "rows" ? "historyRows" : "subagentRows";
					const [min, max] =
						cmd === "rows" ? [HISTORY_ROWS_MIN, HISTORY_ROWS_MAX] : [SUBAGENT_ROWS_MIN, SUBAGENT_ROWS_MAX];
					if (arg === undefined) {
						ctx.ui.notify(`mx-pi-settings ${escapeHtml(cmd)}: ${state.options[key]}`, "info");
						return;
					}
					updateOptions(ctx, {
						[key]: clampInt(arg, min, max, state.options[key]),
					} as Partial<ContextStatsOptions>);
					ctx.ui.notify(`mx-pi-settings ${escapeHtml(cmd)}: ${state.options[key]}`, "info");
					requestRender();
					return;
				}

				case "subagents":
				case "health": {
					const key = cmd === "subagents" ? "showSubagents" : "showHealth";
					if (arg === undefined) {
						ctx.ui.notify(`mx-pi-settings ${escapeHtml(cmd)}: ${state.options[key] ? "on" : "off"}`, "info");
						return;
					}
					const value = arg.toLowerCase();
					if (value !== "on" && value !== "off") {
						ctx.ui.notify(`Expected on|off, got "${escapeHtml(arg)}". ${USAGE}`, "warning");
						return;
					}
					updateOptions(ctx, { [key]: value === "on" } as Partial<ContextStatsOptions>);
					ctx.ui.notify(`mx-pi-settings ${escapeHtml(cmd)}: ${escapeHtml(value)}`, "info");
					requestRender();
					return;
				}

				case "placement": {
					if (arg !== "above" && arg !== "below") {
						ctx.ui.notify(`Expected above|below. ${USAGE}`, "warning");
						return;
					}
					updateOptions(ctx, { placement: arg === "above" ? "aboveEditor" : "belowEditor" });
					// Placement is fixed at registration time, so re-register.
					setupWidget(ctx);
					ctx.ui.notify(`mx-pi-settings placement: ${escapeHtml(arg)}`, "info");
					return;
				}

				case "reset": {
					// History is session data, not config: cleared in memory only.
					state.clearHistory();
					ctx.ui.notify("mx-pi-settings history cleared", "info");
					requestRender();
					return;
				}

				default: {
					ctx.ui.notify(`Unknown mx-pi-settings argument: ${escapeHtml(cmd)}. ${USAGE}`, "warning");
				}
			}
		},
	});
}
