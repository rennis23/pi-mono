import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./channels.js";
import { createSettingsRegistry } from "./registry.js";
import type { ProviderIO, RegistrationPayload, SettingField, SettingsSpec } from "./types.js";

function registration(
	id: string,
	title: string,
	initial: Record<string, boolean | number | string> = { enabled: true },
) {
	const fields: SettingField[] = Object.entries(initial).map(([key, value]) => {
		const base = { key, label: key };
		if (typeof value === "boolean") return { ...base, type: "boolean", default: value };
		if (typeof value === "number") return { ...base, type: "number", default: value };
		return { ...base, type: "string", default: value };
	});
	const spec: SettingsSpec = { id, title, fields };
	let values = { ...initial };
	const io: ProviderIO = {
		id,
		read: () => ({ ...values }),
		write(key, value) {
			values[key] = value;
			return { ok: true, values: { ...values } };
		},
		reset() {
			values = { ...initial };
			return { ok: true, values: { ...values } };
		},
	};
	return { spec, io, protocol: PROTOCOL_VERSION } satisfies RegistrationPayload;
}

describe("settings registry", () => {
	it("accepts registrations and sorts them by title then id", () => {
		const registry = createSettingsRegistry();
		expect(registry.register(registration("mx-pi-z", "Zebra")).accepted).toBe(true);
		expect(registry.register(registration("mx-pi-b", "Alpha")).accepted).toBe(true);
		expect(registry.register(registration("mx-pi-a", "Alpha")).accepted).toBe(true);
		expect(registry.list().map((item) => item.spec.id)).toEqual(["mx-pi-a", "mx-pi-b", "mx-pi-z"]);
	});

	it("replaces an existing provider id idempotently and unregisters by id", () => {
		const registry = createSettingsRegistry();
		const first = registration("mx-pi-a", "First");
		const second = registration("mx-pi-a", "Second");
		registry.register(first);
		expect(registry.register(first)).toMatchObject({ accepted: true, replaced: false });
		expect(registry.register(second)).toMatchObject({ accepted: true, replaced: true });
		expect(registry.get("mx-pi-a")?.spec.title).toBe("Second");
		registry.unregister("mx-pi-a");
		expect(registry.list()).toEqual([]);
	});

	it("rejects malformed, mismatched, and incompatible payloads", () => {
		const registry = createSettingsRegistry();
		expect(registry.register(null).accepted).toBe(false);
		const mismatch = registration("mx-pi-a", "A");
		mismatch.io.id = "mx-pi-b";
		expect(registry.register(mismatch)).toMatchObject({
			accepted: false,
			error: expect.stringContaining("does not match"),
		});
		const incompatible = { ...registration("mx-pi-a", "A"), protocol: PROTOCOL_VERSION + 1 };
		expect(registry.register(incompatible)).toMatchObject({
			accepted: false,
			error: expect.stringContaining("unsupported registration protocol"),
		});
		const invalid = registration("mx-pi-a", "A");
		invalid.spec.fields = [{ key: "rows", label: "Rows", type: "number", default: 11, max: 10 }];
		expect(registry.register(invalid)).toMatchObject({
			accepted: false,
			error: expect.stringContaining("default is above max"),
		});
	});

	it("isolates throwing provider callbacks and falls back to defaults", () => {
		const registry = createSettingsRegistry();
		const payload = registration("mx-pi-a", "A", { enabled: true });
		payload.io.read = () => {
			throw new Error("broken provider");
		};
		payload.io.write = () => {
			throw new Error("write failed");
		};
		registry.register(payload);
		expect(registry.read(payload)).toEqual({ enabled: true });
		expect(registry.write(payload, "enabled", false)).toEqual({ ok: false, error: "write failed" });
	});

	it("round-trips a successful provider write and reset", () => {
		const registry = createSettingsRegistry();
		const payload = registration("mx-pi-a", "A", { enabled: true });
		registry.register(payload);
		expect(registry.write(payload, "enabled", false)).toEqual({ ok: true, values: { enabled: false } });
		expect(registry.read(payload)).toEqual({ enabled: false });
		expect(registry.reset(payload)).toEqual({ ok: true, values: { enabled: true } });
	});

	it("rejects non-primitive reads and malformed mutation results", () => {
		const registry = createSettingsRegistry();
		const payload = registration("mx-pi-a", "A", { enabled: true });
		payload.io.read = () => ({ enabled: { unexpected: true } }) as never;
		payload.io.write = () => ({ ok: true, values: { enabled: { unexpected: true } } }) as never;
		payload.io.reset = () => ({ ok: false, error: 1 }) as never;
		registry.register(payload);
		expect(registry.read(payload)).toEqual({ enabled: true });
		payload.io.read = () => null as never;
		expect(registry.read(payload)).toEqual({ enabled: true });
		payload.io.read = () => [] as never;
		expect(registry.read(payload)).toEqual({ enabled: true });
		payload.io.read = () => ({ enabled: true, extra: Number.POSITIVE_INFINITY }) as never;
		expect(registry.read(payload)).toEqual({ enabled: true });
		payload.io.write = () => null as never;
		expect(registry.write(payload, "enabled", false)).toEqual({
			ok: false,
			error: "provider returned an invalid write result",
		});
		expect(registry.reset(payload)).toEqual({
			ok: false,
			error: "provider returned an invalid reset result",
		});
	});

	it("clears registrations on request", () => {
		const registry = createSettingsRegistry();
		registry.register(registration("mx-pi-a", "A"));
		registry.register(registration("mx-pi-b", "B"));
		registry.clear();
		expect(registry.list()).toEqual([]);
	});
});
