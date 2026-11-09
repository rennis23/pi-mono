import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHost } from "../test/harness.js";
import { SETTINGS_CHANNELS } from "./channels.js";
import { SETTINGS_FLAGS } from "./flags.js";
import { registerSettingsCore } from "./sdk-core.js";
import { createSettingsStore, type SettingsStore } from "./store.js";
import type { RegistrationPayload, SettingsSpec } from "./types.js";

const roots: string[] = [];
function tempPath() {
	const root = mkdtempSync(join(tmpdir(), "mx-pi-settings-sdk-"));
	roots.push(root);
	return join(root, "settings.json");
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spec: SettingsSpec<{ enabled: boolean; rows: number; placement: "above" | "below" }> = {
	id: "mx-pi-example",
	title: "Example",
	fields: [
		{ key: "enabled", label: "Enabled", type: "boolean", default: true },
		{ key: "rows", label: "Rows", type: "number", default: 5, min: 1, max: 10, integer: true },
		{
			key: "placement",
			label: "Placement",
			type: "select",
			default: "below",
			options: [{ value: "above" }, { value: "below" }],
		},
	],
};

describe("provider SDK registration", () => {
	it("registers immediately, re-registers on announce, and unregisters on dispose", () => {
		const { host, bus } = createHost();
		const registrations: unknown[] = [];
		const removals: unknown[] = [];
		bus.events.on(SETTINGS_CHANNELS.register, (data) => registrations.push(data));
		bus.events.on(SETTINGS_CHANNELS.unregister, (data) => removals.push(data));
		const settings = registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		expect(registrations).toHaveLength(1);
		bus.events.emit(SETTINGS_CHANNELS.announce, { protocol: 1, hub: "mx-pi-settings" });
		expect(registrations).toHaveLength(2);
		settings.dispose();
		settings.dispose();
		expect(removals).toEqual([{ id: spec.id }]);
	});

	it("reads defaults and persisted values, validates mutations, and applies callbacks", () => {
		const store = createSettingsStore(tempPath());
		store.writeNamespace(spec.id, { rows: 7, unknown: "keep" });
		const onChange = vi.fn();
		const { host } = createHost();
		const settings = registerSettingsCore(host, { ...spec, onChange }, { store });
		expect(settings.values()).toMatchObject({ enabled: true, rows: 7, placement: "below" });
		expect(settings.get("rows")).toBe(7);
		expect(settings.set("rows", 8)).toMatchObject({ ok: true });
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rows: 8 }), ["rows"]);
		expect(settings.set("rows", 30 as 8)).toMatchObject({ ok: false });
		expect(store.readNamespace(spec.id)).toMatchObject({ rows: 8, unknown: "keep" });
		settings.reset("rows");
		expect(settings.get("rows")).toBe(5);
		expect(store.readNamespace(spec.id)).toEqual({ unknown: "keep" });
		settings.reset();
		expect(store.readNamespace(spec.id)).toEqual({});
	});

	it("ignores stored values that fail the registered field constraints", () => {
		const store = createSettingsStore(tempPath());
		store.writeNamespace(spec.id, { rows: 999, placement: "sideways" });
		const { host } = createHost();
		const settings = registerSettingsCore(host, spec, { store });
		expect(settings.values()).toMatchObject({ rows: 5, placement: "below" });
	});

	it("applies hub-broadcast runtime overrides and store path", () => {
		const path = tempPath();
		const { host, bus, flags } = createHost();
		const settings = registerSettingsCore(host, spec);
		flags.set(SETTINGS_FLAGS.store, `  ${path}  `);
		flags.set(SETTINGS_FLAGS.set, "mx-pi-example.rows=9");
		bus.events.emit(SETTINGS_CHANNELS.configure, {
			protocol: 1,
			storePath: flags.get(SETTINGS_FLAGS.store),
			assignments: flags.get(SETTINGS_FLAGS.set),
		});
		expect(settings.get("rows")).toBe(9);
		settings.set("rows", 6);
		expect(settings.get("rows")).toBe(9); // CLI override wins for this run.
		expect(JSON.parse(readFileSync(path, "utf8")).values[spec.id].rows).toBe(6);
	});

	it("rejects invalid specs and guards unknown provider keys", () => {
		const { host, bus } = createHost();
		expect(() => registerSettingsCore(host, { ...spec, id: "Bad ID" })).toThrow("Invalid settings spec");
		let payload: RegistrationPayload | undefined;
		bus.events.on(SETTINGS_CHANNELS.register, (data) => {
			payload = data as RegistrationPayload;
		});
		registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		expect(payload?.io.write("missing", true)).toEqual({
			ok: false,
			error: 'unknown setting "missing" for mx-pi-example',
		});
		expect(payload?.io.reset("missing")).toEqual({
			ok: false,
			error: 'unknown setting "missing" for mx-pi-example',
		});
	});

	it("notifies providers only when runtime configuration changes a value", () => {
		const onChange = vi.fn();
		const { host, bus } = createHost();
		const settings = registerSettingsCore(host, { ...spec, onChange }, { store: createSettingsStore(tempPath()) });
		bus.events.emit(SETTINGS_CHANNELS.configure, { protocol: 1, assignments: "mx-pi-example.rows=5" });
		expect(onChange).not.toHaveBeenCalled();
		bus.events.emit(SETTINGS_CHANNELS.configure, { protocol: 1, assignments: "mx-pi-example.rows=9" });
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rows: 9 }), ["rows"]);
		expect(settings.get("rows")).toBe(9);
	});

	it("stops publishing registrations once disposed", () => {
		const { host, bus } = createHost();
		const registrations: unknown[] = [];
		bus.events.on(SETTINGS_CHANNELS.register, (data) => registrations.push(data));
		const settings = registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		settings.dispose();
		bus.events.emit(SETTINGS_CHANNELS.announce, { protocol: 1, hub: "mx-pi-settings" });
		expect(registrations).toHaveLength(1);
	});

	it("announces its removal when the session shuts down", () => {
		const { host, bus, fire } = createHost();
		const removals: unknown[] = [];
		bus.events.on(SETTINGS_CHANNELS.unregister, (data) => removals.push(data));
		registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		fire("session_shutdown");
		expect(removals).toEqual([{ id: spec.id }]);
	});

	it("returns persistence failures and swallows provider callback failures", () => {
		const path = tempPath();
		const brokenStore: SettingsStore = {
			path,
			readAll: () => ({ version: 1, values: {} }),
			readNamespace: () => ({}),
			writeNamespace: () => {},
			patchNamespace: () => {
				throw new Error("disk full");
			},
			clearNamespace: () => {
				throw new Error("disk full");
			},
		};
		const { host } = createHost();
		const settings = registerSettingsCore(host, spec, { store: brokenStore });
		expect(settings.set("rows", 8)).toEqual({ ok: false, error: "disk full" });
		expect(settings.reset()).toEqual({ ok: false, error: "disk full" });
		const callbackThrows = registerSettingsCore<{
			enabled: boolean;
			rows: number;
			placement: "above" | "below";
		}>(
			host,
			{
				...spec,
				onChange() {
					throw new Error("provider callback failed");
				},
			},
			{ store: createSettingsStore(tempPath()) },
		);
		expect(callbackThrows.set("rows", 8)).toMatchObject({ ok: true });
	});

	it("ignores malformed runtime-config events", () => {
		const { host, bus } = createHost();
		const settings = registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		bus.events.emit(SETTINGS_CHANNELS.configure, { protocol: 99, assignments: "mx-pi-example.rows=9" });
		expect(settings.get("rows")).toBe(5);
		bus.events.emit(SETTINGS_CHANNELS.configure, { protocol: 1, assignments: true });
		expect(settings.get("rows")).toBe(5);
	});

	it("works without a listening hub and disposes on session shutdown", () => {
		const { host, fire } = createHost();
		const settings = registerSettingsCore(host, spec, { store: createSettingsStore(tempPath()) });
		expect(settings.get("enabled")).toBe(true);
		fire("session_shutdown");
		settings.dispose();
		expect(settings.set("enabled", false)).toMatchObject({ ok: true });
	});
});
