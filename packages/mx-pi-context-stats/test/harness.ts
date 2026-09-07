/**
 * Test doubles for the pi extension API.
 *
 * The extension only touches a handful of pi surfaces (`pi.on`, `pi.register*`,
 * `ctx.ui.setStatus/setWidget/notify`, `ctx.getContextUsage`), so a small fake is
 * enough to drive it end to end without a TUI.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Theme that echoes plain text, keeping assertions free of ANSI codes. */
export const mockTheme = {
	fg: (_color: ThemeColor, text: string) => text,
};

export interface CommandDef {
	description?: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

type AnyHandler = (event: any, ctx: any) => unknown;

export interface HarnessOptions {
	contextWindow?: number;
	/** Value returned by `ctx.getContextUsage()`; undefined means "unknown". */
	usage?: { tokens: number | null; contextWindow: number } | undefined;
	/** Whether the fake ctx reports dialog-capable UI (`ctx.hasUI`). Default true (TUI). */
	hasUI?: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, AnyHandler>();
	const commands = new Map<string, CommandDef>();
	const flags = new Map<string, any>();
	const flagValues = new Map<string, boolean | string>();

	const ui = {
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		notify: vi.fn(),
		setWorkingMessage: vi.fn(),
		// Dialogs default to "dismissed" (undefined); tests queue values with
		// `ui.select.mockResolvedValueOnce(...)`.
		select: vi.fn(async (): Promise<string | undefined> => undefined),
		input: vi.fn(async (): Promise<string | undefined> => undefined),
	};

	const ctx = {
		ui,
		mode: "tui",
		hasUI: options.hasUI ?? true,
		model: { contextWindow: options.contextWindow ?? 128_000 },
		getContextUsage: vi.fn(() => options.usage),
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: AnyHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, def: CommandDef) => {
			commands.set(name, def);
		},
		registerFlag: (name: string, def: any) => {
			flags.set(name, def);
		},
		getFlag: (name: string) => flagValues.get(name),
	} as unknown as ExtensionAPI;

	type WidgetFactory = (tui: unknown, theme: unknown) => { render: (width: number) => string[] };

	/** The widget factory handed to `setWidget` on the most recent call. */
	const widgetFactory = (): WidgetFactory | undefined => {
		const calls = ui.setWidget.mock.calls;
		const last = calls[calls.length - 1];
		return last?.[1] as WidgetFactory | undefined;
	};

	return {
		pi,
		ctx,
		ui,
		handlers,
		commands,
		flags,
		flagValues,
		widgetFactory,

		/** Invoke a registered event handler with the shared mock ctx. */
		emit: async (event: string, payload: any = {}) => {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for "${event}"`);
			await handler(payload, ctx);
		},

		/** Invoke the registered `/mx-pi-settings` handler. */
		runCommand: async (args: string) => {
			const def = commands.get("mx-pi-settings");
			if (!def) throw new Error("mx-pi-settings command was not registered");
			await def.handler(args, ctx as unknown as ExtensionCommandContext);
		},

		/** Render the widget at `width` using the captured factory. */
		render: (width = 100): string[] => {
			const factory = widgetFactory();
			if (!factory) return [];
			return factory({ requestRender: vi.fn() }, mockTheme).render(width);
		},
	};
}
