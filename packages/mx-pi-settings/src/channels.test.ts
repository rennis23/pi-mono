import { describe, expect, it } from "vitest";
import {
	isRegistrationPayload,
	isRuntimeConfigPayload,
	isSettingsSpec,
	PROTOCOL_VERSION,
	readUnregisterId,
} from "./channels.js";
import type { ProviderIO, RegistrationPayload, SettingsSpec } from "./types.js";

const spec: SettingsSpec = {
	id: "mx-pi-test",
	title: "Test",
	fields: [{ key: "enabled", label: "Enabled", type: "boolean", default: true }],
};
const io: ProviderIO = {
	id: spec.id,
	read: () => ({ enabled: true }),
	write: () => ({ ok: true, values: { enabled: true } }),
	reset: () => ({ ok: true, values: { enabled: true } }),
};
const payload: RegistrationPayload = { spec, io, protocol: PROTOCOL_VERSION };

describe("event bus payload guards", () => {
	it("accepts only structurally valid settings specs and registrations", () => {
		expect(isSettingsSpec(spec)).toBe(true);
		expect(isSettingsSpec(null)).toBe(false);
		expect(isSettingsSpec({ id: "", title: "Test", fields: [] })).toBe(false);
		expect(isSettingsSpec({ id: "mx-pi-test", title: 1, fields: [] })).toBe(false);
		expect(isSettingsSpec({ id: "mx-pi-test", title: "Test", fields: {} })).toBe(false);
		expect(isRegistrationPayload(payload)).toBe(true);
		expect(isRegistrationPayload({ ...payload, io: { id: spec.id } })).toBe(false);
		expect(isRegistrationPayload({ ...payload, io: { id: spec.id, read: io.read, reset: io.reset } })).toBe(false);
		expect(isRegistrationPayload({ ...payload, io: { id: spec.id, read: io.read, write: io.write } })).toBe(false);
		expect(isRegistrationPayload({ ...payload, io: { ...io, id: 1 } })).toBe(false);
		expect(isRegistrationPayload({ ...payload, protocol: "1" })).toBe(false);
	});

	it("validates runtime configuration protocol and optional values", () => {
		expect(isRuntimeConfigPayload({ protocol: PROTOCOL_VERSION })).toBe(true);
		expect(
			isRuntimeConfigPayload({
				protocol: PROTOCOL_VERSION,
				assignments: "mx-pi-test.enabled=off",
				storePath: "/tmp/store.json",
			}),
		).toBe(true);
		expect(isRuntimeConfigPayload({ protocol: PROTOCOL_VERSION, assignments: true })).toBe(false);
		expect(isRuntimeConfigPayload({ protocol: PROTOCOL_VERSION, storePath: 1 })).toBe(false);
		expect(isRuntimeConfigPayload({ protocol: 999 })).toBe(false);
	});

	it("extracts unregister ids from a string or object and ignores malformed data", () => {
		expect(readUnregisterId("mx-pi-test")).toBe("mx-pi-test");
		expect(readUnregisterId({ id: "mx-pi-test" })).toBe("mx-pi-test");
		expect(readUnregisterId({ id: "" })).toBeUndefined();
		expect(readUnregisterId({ id: 1 })).toBeUndefined();
		expect(readUnregisterId(1)).toBeUndefined();
		expect(readUnregisterId(null)).toBeUndefined();
	});
});
