/**
 * Test doubles for the pi extension API.
 *
 * `index.ts` touches a small surface: `pi.on`, `pi.register*`, `pi.getFlag`,
 * `pi.getActiveTools`, `ctx.ui.*` and `ctx.modelRegistry`. This harness
 * implements exactly that, plus a captured tool registry so tests can invoke
 * `mx_pi_agent` end to end without a TUI or a model.
 *
 * Config and agent dirs are always injected temp paths — the real `~/.pi` is
 * never touched.
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
	bold: (text: string) => text,
};

export interface CommandDef {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ToolDef {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
}

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface HarnessOptions {
	/** Value returned by `ctx.cwd`. */
	cwd?: string;
	/** Whether dialog-capable UI is available. Default true. */
	hasUI?: boolean;
	/** Tool names reported by `pi.getActiveTools()`. */
	activeTools?: string[];
	/** Flag values, keyed by flag name. */
	flags?: Record<string, boolean | string>;
	/** Confirmation dialog result. Default false (refuse). */
	confirmResult?: boolean;
	/** Environment passed to `createRedactor`-style redaction checks. */
	env?: Record<string, string>;
}

export function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, AnyHandler[]>();
	const commands = new Map<string, CommandDef>();
	const tools = new Map<string, ToolDef>();
	const flags = new Map<string, unknown>();
	const flagValues = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
	const notifications: Array<{ message: string; type?: string }> = [];

	const ui = {
		notify: vi.fn((message: string, type?: string) => {
			notifications.push({ message, type });
		}),
		confirm: vi.fn(async () => options.confirmResult ?? false),
		select: vi.fn(async () => undefined),
		input: vi.fn(async () => undefined),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		theme: mockTheme,
	};

	const modelRegistry = {
		find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
		getAll: vi.fn(() => [] as Array<{ provider: string; id: string }>),
	};

	const ctx = {
		ui,
		mode: "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		abort: vi.fn(),
		shutdown: vi.fn(),
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, def: CommandDef) => {
			commands.set(name, def);
		},
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
		registerFlag: (name: string, def: unknown) => {
			flags.set(name, def);
		},
		getFlag: (name: string) => flagValues.get(name),
		getActiveTools: () => options.activeTools ?? ["read", "grep", "bash"],
		getAllTools: () => [],
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		ui,
		notifications,
		modelRegistry,
		handlers,
		commands,
		tools,
		flags,
		flagValues,

		/** Invoke every registered handler for an event, in registration order. */
		emit: async (event: string, payload: Record<string, unknown> = {}) => {
			const list = handlers.get(event);
			if (!list || list.length === 0) throw new Error(`no handler registered for "${event}"`);
			for (const handler of list) await handler({ type: event, ...payload }, ctx);
		},

		/** Invoke the `/mx-pi-agents` command handler. */
		runCommand: async (args: string) => {
			const def = commands.get("mx-pi-agents");
			if (!def) throw new Error("mx-pi-agents command was not registered");
			await def.handler(args, ctx as unknown as ExtensionCommandContext);
		},

		/** Invoke a registered tool. */
		runTool: async (
			name: string,
			params: Record<string, unknown>,
			options: { signal?: AbortSignal; onUpdate?: (partial: unknown) => void } = {},
		) => {
			const def = tools.get(name);
			if (!def) throw new Error(`tool "${name}" was not registered`);
			return def.execute("call-1", params, options.signal, options.onUpdate, ctx);
		},

		/** Text of the last notification, for assertions. */
		lastNotification: () => notifications[notifications.length - 1],

		/** All notification messages joined, for substring assertions. */
		notificationText: () => notifications.map((entry) => entry.message).join("\n"),
	};
}

export type Harness = ReturnType<typeof createHarness>;
