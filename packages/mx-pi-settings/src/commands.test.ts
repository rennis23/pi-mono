import { describe, expect, it } from "vitest";
import { executeSettingsCommand, parseSettingsCommand, SETTINGS_USAGE } from "./commands.js";
import { createSettingsRegistry } from "./registry.js";
import type { ProviderIO, RegistrationPayload, SettingsSpec } from "./types.js";

function makeRegistry() {
	const registry = createSettingsRegistry();
	const spec: SettingsSpec = {
		id: "mx-pi-sample",
		title: "Sample",
		description: "Sample settings",
		fields: [
			{ key: "enabled", label: "Enabled", type: "boolean", default: true },
			{ key: "rows", label: "Rows", type: "number", default: 5, min: 1, max: 10, integer: true },
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
	};
	let values = { enabled: true, rows: 5, placement: "below" };
	const io: ProviderIO = {
		id: spec.id,
		read: () => ({ ...values }),
		write(key, value) {
			values = { ...values, [key]: value } as typeof values;
			return { ok: true, values: { ...values } };
		},
		reset(key) {
			if (key)
				values = { ...values, [key]: spec.fields.find((field) => field.key === key)?.default } as typeof values;
			else values = { enabled: true, rows: 5, placement: "below" };
			return { ok: true, values: { ...values } };
		},
	};
	registry.register({ spec, io, protocol: 1 } satisfies RegistrationPayload);
	return registry;
}

describe("settings commands", () => {
	it("parses open/help/list/get/set/reset commands", () => {
		expect(parseSettingsCommand("")).toEqual({ kind: "open" });
		expect(parseSettingsCommand("help")).toEqual({ kind: "help" });
		expect(parseSettingsCommand("list mx-pi-sample")).toEqual({ kind: "list", id: "mx-pi-sample" });
		expect(parseSettingsCommand("list mx-pi-sample.rows")).toEqual({
			kind: "error",
			message: `list accepts an extension id only. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("get mx-pi-sample.rows")).toEqual({ kind: "get", id: "mx-pi-sample", key: "rows" });
		expect(parseSettingsCommand("set mx-pi-sample.rows 8")).toEqual({
			kind: "set",
			id: "mx-pi-sample",
			key: "rows",
			value: "8",
		});
		expect(parseSettingsCommand("reset mx-pi-sample")).toEqual({ kind: "reset", id: "mx-pi-sample" });
	});

	it("preserves spaces in string values and reports invalid command syntax", () => {
		expect(parseSettingsCommand("set mx-pi-sample.title hello world")).toMatchObject({ value: "hello world" });
		expect(parseSettingsCommand("set rows 4")).toMatchObject({
			kind: "error",
			message: `set needs id.key. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("nope")).toEqual({
			kind: "error",
			message: `Unknown command "nope". ${SETTINGS_USAGE}`,
		});
	});

	it("rejects malformed ids and missing arguments with actionable outcomes", () => {
		const registry = makeRegistry();
		expect(parseSettingsCommand("get mx-pi-sample.rows")).toEqual({ kind: "get", id: "mx-pi-sample", key: "rows" });
		expect(parseSettingsCommand("get  mx-pi-sample.rows")).toEqual({ kind: "get", id: "mx-pi-sample", key: "rows" });
		expect(parseSettingsCommand("list bad.id")).toEqual({
			kind: "error",
			message: `list accepts an extension id only. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("get")).toMatchObject({
			kind: "error",
			message: `get needs an id or id.key. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("set mx-pi-sample.rows")).toMatchObject({
			kind: "error",
			message: `set needs id.key and a value. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("set bad.id.rows 2")).toMatchObject({
			kind: "error",
			message: `set needs id.key. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("reset bad..id")).toMatchObject({
			kind: "error",
			message: `reset needs an id or id.key. ${SETTINGS_USAGE}`,
		});
		expect(parseSettingsCommand("reset")).toMatchObject({
			kind: "error",
			message: `reset needs an id or id.key. ${SETTINGS_USAGE}`,
		});
		expect(executeSettingsCommand({ kind: "open" }, registry).openUI).toBe(true);
		expect(executeSettingsCommand({ kind: "help" }, registry).type).toBe("info");
	});

	it("handles empty registry, unknown fields, and invalid resets", () => {
		const empty = createSettingsRegistry();
		expect(executeSettingsCommand({ kind: "list" }, empty).text).toBe("No extensions have registered settings.");
		expect(executeSettingsCommand({ kind: "list", id: "mx-pi-missing" }, empty)).toEqual({
			text: 'No settings registered for "mx-pi-missing".',
			type: "warning",
		});
		const registry = makeRegistry();
		expect(executeSettingsCommand({ kind: "get", id: "mx-pi-sample", key: "missing" }, registry)).toEqual({
			text: 'Unknown setting "mx-pi-sample.missing".',
			type: "warning",
		});
		expect(executeSettingsCommand({ kind: "set", id: "mx-pi-sample", key: "missing", value: "1" }, registry)).toEqual(
			{
				text: 'Unknown setting "mx-pi-sample.missing".',
				type: "warning",
			},
		);
		expect(executeSettingsCommand({ kind: "reset", id: "mx-pi-sample", key: "missing" }, registry)).toEqual({
			text: 'Unknown setting "mx-pi-sample.missing".',
			type: "warning",
		});
	});

	it("lists and gets registered values", () => {
		const registry = makeRegistry();
		expect(executeSettingsCommand({ kind: "list" }, registry).text).toContain("Sample (mx-pi-sample)");
		expect(executeSettingsCommand({ kind: "list", id: "mx-pi-sample" }, registry).text).toContain("rows: 5");
		expect(executeSettingsCommand({ kind: "list", id: "mx-pi-sample" }, registry).text).toContain(
			"  Sample settings",
		);
		expect(executeSettingsCommand({ kind: "get", id: "mx-pi-sample", key: "rows" }, registry).text).toBe(
			"mx-pi-sample.rows=5",
		);
		expect(executeSettingsCommand({ kind: "get", id: "mx-pi-missing" }, registry).type).toBe("warning");
		expect(executeSettingsCommand({ kind: "get", id: "mx-pi-sample" }, registry).text).toContain(
			"Sample (mx-pi-sample)",
		);
	});

	it("validates, writes, and resets values", () => {
		const registry = makeRegistry();
		expect(executeSettingsCommand({ kind: "set", id: "mx-pi-sample", key: "rows", value: "8" }, registry).text).toBe(
			"mx-pi-sample.rows=8",
		);
		expect(executeSettingsCommand({ kind: "set", id: "mx-pi-sample", key: "rows", value: "20" }, registry).text).toBe(
			"Invalid value for mx-pi-sample.rows: must be at most 10",
		);
		expect(executeSettingsCommand({ kind: "reset", id: "mx-pi-sample", key: "rows" }, registry).text).toContain(
			"Reset",
		);
		expect(executeSettingsCommand({ kind: "get", id: "mx-pi-sample", key: "rows" }, registry).text).toBe(
			"mx-pi-sample.rows=5",
		);
		expect(executeSettingsCommand({ kind: "reset", id: "mx-pi-sample" }, registry).text).toBe(
			"Reset mx-pi-sample to defaults.",
		);
	});

	it("reports provider reset errors without throwing", () => {
		const registry = makeRegistry();
		const registration = registry.get("mx-pi-sample");
		if (!registration) throw new Error("test provider missing");
		registration.io.reset = () => ({ ok: false, error: "reset blocked" });
		expect(executeSettingsCommand({ kind: "reset", id: "mx-pi-sample" }, registry)).toEqual({
			text: "Could not reset mx-pi-sample: reset blocked",
			type: "warning",
		});
	});

	it("reports provider write errors without throwing", () => {
		const registry = makeRegistry();
		const registration = registry.get("mx-pi-sample");
		if (!registration) throw new Error("test provider missing");
		registration.io.write = () => ({ ok: false, error: "disk full" });
		const result = executeSettingsCommand({ kind: "set", id: "mx-pi-sample", key: "rows", value: "8" }, registry);
		expect(result).toEqual({ text: "Could not update mx-pi-sample.rows: disk full", type: "warning" });
	});
});
