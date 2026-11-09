/**
 * Test doubles for the pi extension API.
 *
 * `index.ts` touches a small surface: `pi.on`, `pi.register*`, `pi.getFlag`,
 * `pi.getActiveTools`, `pi.getAllTools`, `pi.getThinkingLevel`,
 * `pi.setThinkingLevel`, `pi.setModel`, `pi.appendEntry`, `pi.events` and
 * `ctx.ui.*` / `ctx.modelRegistry`. This harness implements exactly that. No
 * tool is registered by the persona-only extension.
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

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface HarnessOptions {
	/** Value returned by `ctx.cwd`. */
	cwd?: string;
	/** Whether dialog-capable UI is available. Default true. */
	hasUI?: boolean;
	/** Context mode reported by `ctx.mode`. Default "tui". */
	mode?: string;
	/** Tool names reported by `pi.getActiveTools()`. */
	activeTools?: string[];
	/** Tool names reported by `pi.getAllTools()`. Defaults to the built-in set. */
	allTools?: string[];
	/** Flag values, keyed by flag name. */
	flags?: Record<string, boolean | string>;
	/** Confirmation dialog result. Default false (refuse). */
	confirmResult?: boolean;
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
	const flags = new Map<string, unknown>();
	const flagValues = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
	const notifications: Array<{ message: string; type?: string }> = [];
	/** Factories registered with `ctx.ui.addAutocompleteProvider`. */
	const autocompleteFactories: Array<(current: unknown) => unknown> = [];
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
		mode: options.mode ?? "tui",
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
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		ui,
		notifications,
		autocompleteFactories,
		events,
		modelRegistry,
		handlers,
		commands,
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

		/** Text of the last notification, for assertions. */
		lastNotification: () => notifications[notifications.length - 1],

		/** All notification messages joined, for substring assertions. */
		notificationText: () => notifications.map((entry) => entry.message).join("\n"),
	};
}

export type Harness = ReturnType<typeof createHarness>;
