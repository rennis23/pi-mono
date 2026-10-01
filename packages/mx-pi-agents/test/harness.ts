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
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { ThinkingLevel } from "../src/types.js";

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
	/** Tool names reported by `pi.getAllTools()`. Defaults to the built-in set. */
	allTools?: string[];
	/** Flag values, keyed by flag name. */
	flags?: Record<string, boolean | string>;
	/** Confirmation dialog result. Default false (refuse). */
	confirmResult?: boolean;
	/** Environment passed to `createRedactor`-style redaction checks. */
	env?: Record<string, string>;
	/** Session id reported by `ctx.sessionManager.getSessionId()`. */
	sessionId?: string;
	/** Initial session branch entries; `appendEntry` adds to the same list. */
	branch?: Array<Record<string, unknown>>;
	/** Thinking level reported by `pi.getThinkingLevel()`. Default "medium". */
	thinkingLevel?: ThinkingLevel;
}

export function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, AnyHandler[]>();
	const commands = new Map<string, CommandDef>();
	const tools = new Map<string, ToolDef>();
	const flags = new Map<string, unknown>();
	const flagValues = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
	const notifications: Array<{ message: string; type?: string }> = [];
	/** Custom messages passed to `pi.sendMessage`. */
	const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
	/** Renderers registered with `pi.registerMessageRenderer`. */
	const messageRenderers = new Map<string, unknown>();
	/** Factories registered with `ctx.ui.addAutocompleteProvider`. */
	const autocompleteFactories: Array<(current: unknown) => unknown> = [];
	/** Widgets currently set via `ctx.ui.setWidget`, keyed by widget key. */
	const widgets = new Map<string, unknown>();
	/** Handlers registered with `ctx.ui.onTerminalInput`. */
	const terminalHandlers: Array<(data: string) => unknown> = [];
	/** Shared extension event bus, as `pi.events`. */
	const events: EventBus = createEventBus();
	/** Session branch entries: seeds plus anything appended via `pi.appendEntry`. */
	const branchEntries: Array<Record<string, unknown>> = [...(options.branch ?? [])];
	let activeTools = [...(options.activeTools ?? ["read", "grep", "bash"])];
	let thinkingLevel: ThinkingLevel = options.thinkingLevel ?? "medium";

	const ui = {
		notify: vi.fn((message: string, type?: string) => {
			notifications.push({ message, type });
		}),
		confirm: vi.fn(async (_title: string, _body?: string) => options.confirmResult ?? false),
		select: vi.fn(async () => undefined),
		input: vi.fn(async () => undefined),
		setStatus: vi.fn(),
		setWidget: vi.fn((key: string, content: unknown, _options?: unknown) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		}),
		onTerminalInput: vi.fn((handler: (data: string) => unknown) => {
			terminalHandlers.push(handler);
			return () => {
				const index = terminalHandlers.indexOf(handler);
				if (index >= 0) terminalHandlers.splice(index, 1);
			};
		}),
		addAutocompleteProvider: vi.fn((factory: (current: unknown) => unknown) => {
			autocompleteFactories.push(factory);
		}),
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
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-test",
			getBranch: () => [...branchEntries],
		},
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
		events,
		getActiveTools: () => [...activeTools],
		getAllTools: () =>
			(options.allTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]).map((name) => ({ name })),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeTools = [...toolNames];
		}),
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			thinkingLevel = level;
		}),
		setModel: vi.fn(async (model: unknown) => {
			(ctx as { model: unknown }).model = model;
			return true;
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			branchEntries.push({ type: "custom", customType, data, id: `entry-${branchEntries.length}` });
		}),
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			messageRenderers.set(customType, renderer);
		},
		sendMessage: vi.fn(async (message: Record<string, unknown>, sendOptions?: Record<string, unknown>) => {
			messages.push({ message, options: sendOptions });
		}),
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		ui,
		notifications,
		messages,
		messageRenderers,
		autocompleteFactories,
		widgets,
		terminalHandlers,
		events,
		modelRegistry,
		handlers,
		commands,
		tools,
		flags,
		flagValues,
		branchEntries,

		/** Current active tools, after any `setActiveTools` call. */
		activeTools: () => [...activeTools],
		/** Current thinking level, after any `setThinkingLevel` call. */
		currentThinking: () => thinkingLevel,

		/** Invoke every registered handler for an event, in registration order. */
		emit: async (event: string, payload: Record<string, unknown> = {}) => {
			const list = handlers.get(event);
			if (!list || list.length === 0) throw new Error(`no handler registered for "${event}"`);
			let result: unknown;
			for (const handler of list) result = await handler({ type: event, ...payload }, ctx);
			return result;
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
