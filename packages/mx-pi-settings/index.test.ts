import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import mxPiSettings from "./index.js";
import { SETTINGS_CHANNELS } from "./src/channels.js";
import { SETTINGS_FLAGS } from "./src/flags.js";
import { createSettingsRegistry } from "./src/registry.js";
import { openSettingsFallback } from "./src/tui/fallback.js";
import { openSettingsOverlay } from "./src/tui/overlay.js";
import type { RegistrationPayload } from "./src/types.js";

type Handler = (event: any, ctx: any) => unknown;
type BusHandler = (data: unknown) => void;

function makeProvider(id = "mx-pi-example"): RegistrationPayload {
	let values: Record<string, boolean | number | string> = {
		enabled: true,
		rows: 5,
		label: "default",
		placement: "below",
	};
	return {
		protocol: 1,
		spec: {
			id,
			title: "Example",
			description: "A test provider",
			fields: [
				{ key: "enabled", label: "Enabled", type: "boolean", default: true },
				{ key: "rows", label: "Rows", type: "number", default: 5, min: 1, max: 10, integer: true },
				{ key: "label", label: "Label", type: "string", default: "default", maxLength: 20 },
				{
					key: "placement",
					label: "Placement",
					type: "select",
					default: "below",
					options: [
						{ value: "above", label: "Above" },
						{ value: "below", label: "Below" },
					],
				},
			],
		},
		io: {
			id,
			read: () => ({ ...values }),
			write(key, value) {
				values[key] = value;
				return { ok: true, values: { ...values } };
			},
			reset() {
				values = { enabled: true, rows: 5, label: "default", placement: "below" };
				return { ok: true, values: { ...values } };
			},
		},
	};
}

function makeHarness(mode: "tui" | "rpc" | "print" = "tui") {
	initTheme("dark", false);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const flags = new Map<string, unknown>();
	const flagValues = new Map<string, boolean | string>();
	const bus = new Map<string, Set<BusHandler>>();
	let customComponent: Component | undefined;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		style: (text: string) => text,
		getColorMode: () => "truecolor" as const,
	};
	const tui = { requestRender: vi.fn() };
	const events = {
		emit(channel: string, data: unknown) {
			for (const listener of bus.get(channel) ?? []) listener(data);
		},
		on(channel: string, listener: BusHandler) {
			const listeners = bus.get(channel) ?? new Set<BusHandler>();
			listeners.add(listener);
			bus.set(channel, listeners);
			return () => listeners.delete(listener);
		},
	};
	const ui = {
		theme,
		notify: vi.fn(),
		select: vi.fn(async () => undefined as string | undefined),
		input: vi.fn(async () => undefined as string | undefined),
		custom: vi.fn(async (factory: (...args: any[]) => Component, _options?: unknown) => {
			customComponent = factory(tui, theme, {}, () => {});
			return undefined;
		}),
	};
	const ctx = { ui, mode, hasUI: mode === "tui" || mode === "rpc" } as unknown as ExtensionContext;
	const pi = {
		events,
		on(event: string, handler: Handler) {
			const listeners = handlers.get(event) ?? [];
			listeners.push(handler);
			handlers.set(event, listeners);
			return () =>
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((item) => item !== handler),
				);
		},
		registerFlag(name: string, definition: unknown) {
			flags.set(name, definition);
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
		registerCommand(
			name: string,
			definition: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> },
		) {
			commands.set(name, definition);
		},
	} as unknown as ExtensionAPI;

	mxPiSettings(pi);
	return {
		pi,
		ctx,
		ui,
		tui,
		events,
		handlers,
		commands,
		flags,
		flagValues,
		get customComponent() {
			return customComponent;
		},
		async emit(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		async command(name: string, args = "") {
			const command = commands.get(name);
			if (!command) throw new Error(`missing command ${name}`);
			await command.handler(args, ctx as unknown as ExtensionCommandContext);
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("mx-pi-settings extension entry", () => {
	it("registers namespaced CLI flags and both hub commands", async () => {
		const harness = makeHarness();
		expect(harness.flags.get(SETTINGS_FLAGS.open)).toMatchObject({
			type: "boolean",
			description: "Open the mx-pi-settings TUI when the pi session starts",
		});
		expect(harness.flags.get(SETTINGS_FLAGS.set)).toMatchObject({
			type: "string",
			description: 'Run-scoped registered-setting overrides: "extension.key=value[,extension.key=value…]"',
		});
		expect(harness.flags.get(SETTINGS_FLAGS.store)).toMatchObject({
			type: "string",
			description: "Override the mx-pi-settings JSON store path for this run",
		});
		expect(harness.commands.has("mx-pi-settings")).toBe(true);
		expect(harness.commands.has("mx-pi-settings-help")).toBe(true);
		await harness.command("mx-pi-settings-help");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toBe(
			"Usage: /mx-pi-settings [list [<id>]|get <id>[.<key>]|set <id>.<key> <value>|reset <id>[.<key>]|help]",
		);
	});

	it("announces itself and gathers provider registrations without depending on load order", async () => {
		const harness = makeHarness();
		const announcements: unknown[] = [];
		harness.events.on(SETTINGS_CHANNELS.announce, (payload) => announcements.push(payload));
		expect(announcements).toHaveLength(0); // factory-time announce happened before this listener
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await harness.emit("session_start");
		expect(announcements).toEqual([{ protocol: 1, hub: "mx-pi-settings" }]);
		await harness.command("mx-pi-settings", "list");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toContain("Example (mx-pi-example)");
	});

	it("opens the custom overlay and applies a boolean field change", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		expect(harness.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 2 },
		});
		const component = harness.customComponent;
		expect(component?.render(80).join("\n")).toContain("mx-pi-settings");
		expect(component?.render(80).join("\n")).toContain("2 extensions registered");
		expect(component?.render(80).join("\n")).toContain("defaults");
		expect(component?.render(80).join("\n")).toContain("↑↓ navigate • enter edit • / search • esc close");
		for (const glyph of ["┌", "└", "│"]) expect(component?.render(80).join("\n")).toContain(glyph);
		component?.handleInput?.("\r"); // open provider submenu
		expect(component?.render(80).join("\n")).toContain("Enabled");
		component?.handleInput?.("\r"); // cycle enabled → disabled
		expect(provider.io.read()).toMatchObject({ enabled: false });
		component?.handleInput?.("\x1b"); // return to the provider list
		expect(component?.render(80).join("\n")).toContain("1 changed");
	});

	it("renders the hub's own appearance row and closes on esc", async () => {
		const harness = makeHarness("tui");
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		const rendered = component?.render(80).join("\n") ?? "";
		expect(rendered).toContain("1 extension registered");
		expect(rendered).toContain("Appearance of this settings overlay");
		expect(rendered).toContain("esc close");
		for (const glyph of ["┌", "└", "│"]) expect(rendered).toContain(glyph);
		component?.handleInput?.("\x1b");
	});

	it("renders the empty-state overlay for a registry with no providers", async () => {
		const harness = makeHarness("tui");
		await openSettingsOverlay(harness.ctx, createSettingsRegistry());
		const component = harness.customComponent;
		expect(component?.render(80).join("\n")).toContain("No extensions have registered settings yet.");
		expect(component?.render(80).join("\n")).toContain("See the mx-pi-settings SDK to publish your settings.");
		component?.handleInput?.("\x1b");
		component?.handleInput?.("q");
	});

	it("uses the provider id as description when no description is declared", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		delete provider.spec.description;
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		expect(harness.customComponent?.render(80).join("\n")).toContain("mx-pi-example");
	});

	it("edits a numeric field with the focused TUI input", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		component?.handleInput?.("\r"); // open provider submenu
		component?.handleInput?.("\x1b[B"); // select rows
		component?.handleInput?.("\r"); // open number input
		expect(component?.render(80).join("\n")).toContain("Enter a value for rows");
		expect(component?.render(80).join("\n")).toContain("enter save • esc cancel");
		component?.handleInput?.("\x7f"); // remove prefilled 5
		component?.handleInput?.("9");
		component?.handleInput?.("9");
		component?.handleInput?.("\r"); // invalid input stays open with an error
		expect(component?.render(80).join("\n")).toContain("must be at most 10");
		component?.handleInput?.("\x7f");
		component?.handleInput?.("\x7f");
		component?.handleInput?.("8");
		component?.handleInput?.("\r");
		expect(provider.io.read()).toMatchObject({ rows: 8 });
	});

	it("cancels a focused TUI editor without changing the value", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		component?.handleInput?.("\r");
		component?.handleInput?.("\x1b[B");
		component?.handleInput?.("\r");
		component?.handleInput?.("\x7f");
		component?.handleInput?.("8");
		component?.handleInput?.("\x1b");
		expect(provider.io.read()).toMatchObject({ rows: 5 });
	});

	it("filters the provider list through the searchable TUI settings list", async () => {
		const harness = makeHarness("tui");
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		component?.handleInput?.("NoMatch");
		expect(component?.render(80).join("\n")).toContain("No matching settings");
		component?.handleInput?.("\x1b");
	});

	it("pluralizes the provider count for more than one registration", async () => {
		const harness = makeHarness("tui");
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider("mx-pi-one"));
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider("mx-pi-two"));
		await harness.command("mx-pi-settings");
		expect(harness.customComponent?.render(80).join("\n")).toContain("3 extensions registered");
	});

	it("keeps the current value and warns when a provider rejects a TUI mutation", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		provider.io.write = () => ({ ok: false, error: "write failed" });
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		component?.handleInput?.("\r");
		component?.handleInput?.("\r");
		expect(provider.io.read()).toMatchObject({ enabled: true });
		expect(harness.ui.notify).toHaveBeenCalledWith("write failed", "warning");
	});

	it("cycles select values in the TUI provider screen", async () => {
		const harness = makeHarness("tui");
		const provider = makeProvider();
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		await harness.command("mx-pi-settings");
		const component = harness.customComponent;
		component?.handleInput?.("\r"); // open provider submenu
		for (let row = 0; row < 3; row++) component?.handleInput?.("\x1b[B");
		component?.handleInput?.("\r"); // cycle placement below → above
		expect(provider.io.read()).toMatchObject({ placement: "above" });
	});

	it("edits registered values through RPC select and input dialogs", async () => {
		const harness = makeHarness("rpc");
		const provider = makeProvider();
		const registry = createSettingsRegistry();
		registry.register(provider);
		harness.ui.select
			.mockResolvedValueOnce("Example (mx-pi-example)")
			.mockResolvedValueOnce("Enabled [enabled] — on")
			.mockResolvedValueOnce("off")
			.mockResolvedValueOnce(undefined);
		await openSettingsFallback(harness.ctx, registry);
		expect(provider.io.read()).toMatchObject({ enabled: false });
		expect(harness.ui.notify).toHaveBeenCalledWith("mx-pi-example.enabled=off", "info");
	});

	it("reports invalid RPC text input and leaves the setting unchanged", async () => {
		const harness = makeHarness("rpc");
		const provider = makeProvider();
		const registry = createSettingsRegistry();
		registry.register(provider);
		harness.ui.select
			.mockResolvedValueOnce("Example (mx-pi-example)")
			.mockResolvedValueOnce("Label [label] — default")
			.mockResolvedValueOnce(undefined);
		harness.ui.input.mockResolvedValueOnce("this label is much too long");
		await openSettingsFallback(harness.ctx, registry);
		expect(provider.io.read()).toMatchObject({ label: "default" });
		expect(harness.ui.notify).toHaveBeenCalledWith("Invalid Label: must be at most 20 characters", "warning");
	});

	it("reports provider write failures in RPC mode", async () => {
		const harness = makeHarness("rpc");
		const provider = makeProvider();
		provider.io.write = () => ({ ok: false, error: "save blocked" });
		const registry = createSettingsRegistry();
		registry.register(provider);
		harness.ui.select
			.mockResolvedValueOnce("Example (mx-pi-example)")
			.mockResolvedValueOnce("Rows [rows] — 5")
			.mockResolvedValueOnce(undefined);
		harness.ui.input.mockResolvedValueOnce("8");
		await openSettingsFallback(harness.ctx, registry);
		expect(harness.ui.notify).toHaveBeenCalledWith("Could not update Rows: save blocked", "warning");
	});

	it("notifies when no RPC provider is registered", async () => {
		const harness = makeHarness("rpc");
		await openSettingsFallback(harness.ctx, createSettingsRegistry());
		expect(harness.ui.notify).toHaveBeenCalledWith("No extensions have registered settings yet.", "info");
	});

	it("edits numeric fields with the RPC input dialog", async () => {
		const harness = makeHarness("rpc");
		const provider = makeProvider();
		const registry = createSettingsRegistry();
		registry.register(provider);
		harness.ui.select
			.mockResolvedValueOnce("Example (mx-pi-example)")
			.mockResolvedValueOnce("Rows [rows] — 5")
			.mockResolvedValueOnce(undefined);
		harness.ui.input.mockResolvedValueOnce("8");
		await openSettingsFallback(harness.ctx, registry);
		expect(provider.io.read()).toMatchObject({ rows: 8 });
		expect(harness.ui.notify).toHaveBeenCalledWith("mx-pi-example.rows=8", "info");
	});

	it("uses the RPC select dialog to edit select fields", async () => {
		const harness = makeHarness("rpc");
		const provider = makeProvider();
		const registry = createSettingsRegistry();
		registry.register(provider);
		harness.ui.select
			.mockResolvedValueOnce("Example (mx-pi-example)")
			.mockResolvedValueOnce("Placement [placement] — Below")
			.mockResolvedValueOnce("Above")
			.mockResolvedValueOnce(undefined);
		await openSettingsFallback(harness.ctx, registry);
		expect(provider.io.read()).toMatchObject({ placement: "above" });
	});

	it("uses supported dialogs in RPC mode and text output without UI", async () => {
		const rpc = makeHarness("rpc");
		rpc.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await rpc.command("mx-pi-settings");
		expect(rpc.ui.select).toHaveBeenCalledWith("mx-pi-settings — select extension", [
			"Example (mx-pi-example)",
			"mx-pi-settings (mx-pi-settings)",
		]);

		const print = makeHarness("print");
		print.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await print.command("mx-pi-settings");
		expect(print.ui.notify.mock.calls.at(-1)?.[0]).toContain("Example (mx-pi-example)");
	});

	it("warns about invalid runtime overrides after registrations arrive", async () => {
		const harness = makeHarness();
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		harness.flagValues.set(
			SETTINGS_FLAGS.set,
			"mx-pi-example.missing=1,mx-pi-absent.enabled=true,mx-pi-example.enabled=maybe,broken",
		);
		await harness.emit("session_start");
		expect(harness.ui.notify.mock.calls.map(([message]) => message)).toEqual(
			expect.arrayContaining([
				'mx-pi-settings: unknown setting "mx-pi-example.missing"',
				'mx-pi-settings: no settings registered for "mx-pi-absent"',
				"mx-pi-settings: invalid mx-pi-example.enabled: expected one of true, on, yes, 1, false, off, no, 0",
				'mx-pi-settings: expected id.key=value, got "broken"',
			]),
		);
	});

	it("broadcasts runtime flags after startup registration collection", async () => {
		const harness = makeHarness();
		harness.flagValues.set(SETTINGS_FLAGS.store, "  /tmp/mx-pi-settings-store.json  ");
		harness.flagValues.set(SETTINGS_FLAGS.set, "mx-pi-example.rows=8");
		const configurations: unknown[] = [];
		harness.events.on(SETTINGS_CHANNELS.configure, (payload) => configurations.push(payload));
		await harness.emit("session_start");
		expect(configurations).toEqual([
			{ protocol: 1, assignments: "mx-pi-example.rows=8", storePath: "/tmp/mx-pi-settings-store.json" },
		]);
	});

	it("replays runtime flags to providers that register after session startup", async () => {
		const harness = makeHarness();
		harness.flagValues.set(SETTINGS_FLAGS.set, "mx-pi-example.rows=8");
		const configurations: unknown[] = [];
		harness.events.on(SETTINGS_CHANNELS.configure, (payload) => configurations.push(payload));
		const provider = makeProvider();
		await harness.emit("session_start");
		harness.events.emit(SETTINGS_CHANNELS.register, provider);
		expect(configurations).toHaveLength(2); // startup broadcast, then lazy-provider replay
	});

	it("warns and recovers from malformed, incompatible, and duplicate providers", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.events.emit(SETTINGS_CHANNELS.register, null);
		harness.events.emit(SETTINGS_CHANNELS.register, { ...makeProvider(), protocol: 99 });
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		const messages = harness.ui.notify.mock.calls.map(([message]) => String(message));
		expect(messages.filter((message) => message.includes("duplicate provider id")).length).toBe(1);
		expect(messages).toEqual(
			expect.arrayContaining([
				"mx-pi-settings: ignored malformed settings registration",
				"mx-pi-settings: ignored mx-pi-example: unsupported registration protocol 99; expected 1",
				'mx-pi-settings: duplicate provider id "mx-pi-example" replaced the earlier registration',
			]),
		);
	});

	it("unregisters providers and clears the registry at session shutdown", async () => {
		const harness = makeHarness();
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await harness.emit("session_start");
		harness.events.emit(SETTINGS_CHANNELS.unregister, { id: "mx-pi-example" });
		await harness.command("mx-pi-settings", "list");
		const afterUnregister = String(harness.ui.notify.mock.calls.at(-1)?.[0]);
		expect(afterUnregister).toContain("mx-pi-settings (mx-pi-settings)");
		expect(afterUnregister).not.toContain("mx-pi-example");
		harness.events.emit(SETTINGS_CHANNELS.register, makeProvider());
		await harness.emit("session_shutdown");
		await harness.command("mx-pi-settings", "list");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toBe("No extensions have registered settings.");
	});

	it("warns when startup-open is requested outside TUI mode", async () => {
		const harness = makeHarness("rpc");
		harness.flagValues.set(SETTINGS_FLAGS.open, true);
		await harness.emit("session_start");
		expect(harness.ui.notify).toHaveBeenCalledWith("--mx-pi-settings-open is only available in TUI mode.", "warning");
	});

	it("opens on startup only for TUI mode when the boolean flag is set", async () => {
		const harness = makeHarness("tui");
		harness.flagValues.set(SETTINGS_FLAGS.open, true);
		await harness.emit("session_start");
		expect(harness.ui.custom).toHaveBeenCalledTimes(1);
	});

	it("edits and persists the hub's own background color", async () => {
		const harness = makeHarness("tui");
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-settings-"));
		const storePath = join(dir, "mx-pi-settings.json");
		try {
			harness.flagValues.set(SETTINGS_FLAGS.store, storePath);
			await harness.emit("session_start");
			await harness.command("mx-pi-settings");
			const component = harness.customComponent;
			expect(component?.render(80).join("\n")).toContain("1 extension registered");
			component?.handleInput?.("\r"); // open the mx-pi-settings appearance submenu
			expect(component?.render(80).join("\n")).toContain("Background");
			component?.handleInput?.("\r"); // open the inline color editor
			for (let index = 0; index < 7; index++) component?.handleInput?.("\x7f"); // clear #ffb3b3
			component?.handleInput?.("#00ff00");
			component?.handleInput?.("\r");
			expect(readFileSync(storePath, "utf8")).toContain('"background": "#00ff00"');
			await harness.command("mx-pi-settings", "get mx-pi-settings.background");
			expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toBe("mx-pi-settings.background=#00ff00");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
