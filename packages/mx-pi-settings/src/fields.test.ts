import { describe, expect, it } from "vitest";
import {
	cycleToValue,
	cycleValues,
	decodeValue,
	defaultValues,
	findField,
	formatValue,
	isChanged,
	validateSpec,
	validateValue,
} from "./fields.js";
import type { SettingField, SettingsSpec } from "./types.js";

const spec: SettingsSpec = {
	id: "mx-pi-sample",
	title: "Sample",
	fields: [
		{ key: "enabled", label: "Enabled", type: "boolean", default: true },
		{ key: "rows", label: "Rows", type: "number", default: 5, min: 1, max: 10, integer: true, unit: "rows" },
		{ key: "name", label: "Name", type: "string", default: "default", maxLength: 10 },
		{
			key: "placement",
			label: "Placement",
			type: "select",
			default: "below",
			options: [
				{ value: "above", label: "Above editor" },
				{ value: "below", label: "Below editor" },
			],
		},
	],
};

describe("settings field semantics", () => {
	it("validates spec shape, ids, duplicate keys, and select defaults", () => {
		expect(validateSpec(spec)).toBeUndefined();
		expect(validateSpec({ ...spec, id: "Bad ID" })).toContain("invalid id");
		expect(validateSpec({ ...spec, title: "   " })).toBe("missing title");
		expect(validateSpec({ ...spec, title: 1 as never })).toBe("missing title");
		expect(
			validateSpec({
				...spec,
				fields: [
					{ key: "enabled", label: "Enabled", type: "boolean", default: true },
					{ key: "rows", label: "Rows", type: "number", default: 5, min: 1, max: 10, integer: true },
					{ key: "name", label: "Name", type: "string", default: "default", maxLength: 10 },
					{
						key: "placement",
						label: "Placement",
						type: "select",
						default: "above",
						options: [{ value: "above", label: "Above editor" }],
					},
				],
			}),
		).toBeUndefined();
		expect(validateSpec({ ...spec, id: "mx-pi-a!" })).toContain("invalid id");
		expect(validateSpec({ ...spec, id: " mx-pi-a" })).toContain("invalid id");
		expect(validateSpec({ ...spec, fields: [spec.fields[0], spec.fields[0]] })).toContain("duplicate field key");
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "mode", label: "Mode", type: "select", default: "missing", options: [{ value: "ok" }] }],
			}),
		).toContain("not one of its options");
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "rows", label: "Rows", type: "number", default: 11, min: 1, max: 10 }],
			}),
		).toContain("default is above max");
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "mode", label: "Mode", type: "select", default: "a", options: [null] as never[] }],
			}),
		).toContain("each option needs a non-empty string value");
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "rows", label: "Rows", type: "number", default: 5, min: 5, max: 5 }],
			}),
		).toBeUndefined();
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "rows", label: "Rows", type: "number", default: 1.5 }],
			}),
		).toBeUndefined();
		expect(
			validateSpec({
				...spec,
				fields: [{ key: "name", label: "Name", type: "string", default: "x", maxLength: 1 }],
			}),
		).toBeUndefined();
	});

	it("rejects malformed field specs and invalid defaults for every field type", () => {
		const invalidCases: Array<{ field: unknown; message: string }> = [
			{ field: null, message: "field must be an object" },
			{ field: { key: "bad key", label: "x", type: "boolean", default: true }, message: "invalid field key" },
			{ field: { key: "x", label: "", type: "boolean", default: true }, message: "missing label" },
			{ field: { key: "x", label: "   ", type: "boolean", default: true }, message: "missing label" },
			{
				field: { key: "x", label: "x", type: "boolean", default: true, trueLabel: "off" },
				message: "labels must differ",
			},
			{ field: { key: "x", label: "x", type: "other", default: true }, message: "unknown type" },
			{ field: { key: "x", label: "x", type: "boolean", default: "yes" }, message: "default must be a boolean" },
			{ field: { key: "x", label: "x", type: "boolean", default: true, trueLabel: 1 }, message: "trueLabel" },
			{ field: { key: "x", label: "x", type: "boolean", default: true, falseLabel: 1 }, message: "falseLabel" },
			{
				field: { key: "x", label: "x", type: "boolean", default: true, trueLabel: "same", falseLabel: "same" },
				message: "labels must differ",
			},
			{ field: { key: "x", label: "x", type: "number", default: Number.NaN }, message: "finite number" },
			{ field: { key: "x", label: "x", type: "number", default: 1, min: "low" }, message: "min must" },
			{
				field: { key: "x", label: "x", type: "number", default: 1, max: Number.POSITIVE_INFINITY },
				message: "max must",
			},
			{ field: { key: "x", label: "x", type: "number", default: 1, min: 5, max: 2 }, message: "min is greater" },
			{ field: { key: "x", label: "x", type: "number", default: 1, integer: "yes" }, message: "integer must" },
			{ field: { key: "x", label: "x", type: "number", default: 1.5, integer: true }, message: "whole number" },
			{ field: { key: "x", label: "x", type: "number", default: 1, min: 2 }, message: "below min" },
			{ field: { key: "x", label: "x", type: "string", default: 1 }, message: "default must be a string" },
			{ field: { key: "x", label: "x", type: "string", default: "x", maxLength: 0 }, message: "positive integer" },
			{
				field: { key: "x", label: "x", type: "string", default: "long", maxLength: 2 },
				message: "exceeds maxLength",
			},
			{ field: { key: "x", label: "x", type: "string", default: "x", placeholder: 1 }, message: "placeholder" },
			{ field: { key: "x", label: "x", type: "color", default: 1 }, message: "default must be a string" },
			{ field: { key: "x", label: "x", type: "color", default: "#GGGGGG" }, message: "default must be" },
			{ field: { key: "x", label: "x", type: "color", default: "#AABBCC" }, message: "default must be" },
			{
				field: { key: "x", label: "x", type: "color", default: "#ffb3b3", placeholder: 1 },
				message: "placeholder",
			},
			{
				field: { key: "x", label: "x", type: "select", default: 1, options: [{ value: "x" }] },
				message: "default must be a string",
			},
			{ field: { key: "x", label: "x", type: "select", default: "x", options: [] }, message: "at least one option" },
			{
				field: { key: "x", label: "x", type: "select", default: "x", options: [{ value: "x", label: 1 }] },
				message: "labels must be strings",
			},
			{
				field: { key: "x", label: "x", type: "select", default: "x", options: [{ value: "x" }, { value: "x" }] },
				message: "duplicate option value",
			},
			{
				field: {
					key: "x",
					label: "x",
					type: "select",
					default: "a",
					options: [
						{ value: "a", label: "same" },
						{ value: "b", label: "same" },
					],
				},
				message: "duplicate option label",
			},
		];
		for (const { field, message } of invalidCases) {
			expect(validateSpec({ ...spec, fields: [field] as never })).toContain(message);
		}
	});

	it("builds defaults and finds fields", () => {
		expect(defaultValues(spec)).toEqual({ enabled: true, rows: 5, name: "default", placement: "below" });
		expect(findField(spec, "rows")?.type).toBe("number");
		expect(findField(spec, "absent")).toBeUndefined();
	});

	it("decodes booleans from supported literals and rejects ambiguous values", () => {
		const field = spec.fields[0];
		expect(decodeValue(field, "YES")).toEqual({ ok: true, value: true });
		expect(decodeValue(field, "true")).toEqual({ ok: true, value: true });
		expect(decodeValue(field, "on")).toEqual({ ok: true, value: true });
		expect(decodeValue(field, "1")).toEqual({ ok: true, value: true });
		expect(decodeValue(field, 1)).toEqual({ ok: true, value: true });
		expect(decodeValue(field, 0)).toEqual({ ok: true, value: false });
		expect(decodeValue(field, null).ok).toBe(false);
		expect(decodeValue(field, "false")).toEqual({ ok: true, value: false });
		expect(decodeValue(field, "off")).toEqual({ ok: true, value: false });
		expect(decodeValue(field, "no")).toEqual({ ok: true, value: false });
		expect(decodeValue(field, "0")).toEqual({ ok: true, value: false });
		expect(decodeValue(field, " on ")).toEqual({ ok: true, value: true });
		expect(decodeValue(field, 2).ok).toBe(false);
		expect(decodeValue(field, null)).toEqual({ ok: false, error: "expected true|false" });
		expect(decodeValue(field, {})).toEqual({ ok: false, error: "expected true|false" });
		expect(decodeValue(field, "sometimes")).toEqual({
			ok: false,
			error: "expected one of true, on, yes, 1, false, off, no, 0",
		});
		expect(validateValue(field, false)).toEqual({ ok: true, value: false });
		expect(validateValue(field, "not boolean" as never)).toEqual({
			ok: false,
			error: 'expected true|false, got "not boolean"',
		});
	});

	it("checks number bounds, finiteness, and integer requirements", () => {
		const field = spec.fields[1];
		expect(decodeValue(field, "8")).toEqual({ ok: true, value: 8 });
		expect(decodeValue(field, "1")).toEqual({ ok: true, value: 1 });
		expect(decodeValue(field, "10")).toEqual({ ok: true, value: 10 });
		expect(validateValue(field, 1)).toEqual({ ok: true, value: 1 });
		expect(validateValue(field, 0)).toEqual({ ok: false, error: "must be at least 1" });
		expect(validateValue(field, "bad" as never)).toMatchObject({ ok: false, error: 'expected a number, got "bad"' });
		expect(decodeValue(field, "11")).toEqual({ ok: false, error: "must be at most 10" });
		expect(decodeValue(field, "4.5")).toEqual({ ok: false, error: "must be a whole number" });
		expect(decodeValue(field, "Infinity")).toEqual({ ok: false, error: "expected a number" });
	});

	it("trims and caps strings, and checks select values by value or label", () => {
		const name = spec.fields[2];
		const placement = spec.fields[3];
		expect(decodeValue(name, "  hello ")).toEqual({ ok: true, value: "hello" });
		expect(decodeValue(name, "1234567890")).toEqual({ ok: true, value: "1234567890" });
		expect(decodeValue(name, "")).toEqual({ ok: true, value: "" });
		expect(decodeValue(name, 1).ok).toBe(false);
		expect(decodeValue(name, "a very long name").ok).toBe(false);
		expect(validateValue(name, "1234567890")).toEqual({ ok: true, value: "1234567890" });
		expect(validateValue(name, "a very long name")).toMatchObject({
			ok: false,
			error: "must be at most 10 characters",
		});
		expect(decodeValue(name, 1)).toEqual({ ok: false, error: "expected text" });
		expect(decodeValue(name, "a very long name")).toEqual({ ok: false, error: "must be at most 10 characters" });
		expect(validateValue(name, 1 as never)).toMatchObject({ ok: false, error: "expected text, got 1" });
		expect(decodeValue(placement, "Above editor")).toEqual({ ok: true, value: "above" });
		expect(decodeValue(placement, "above")).toEqual({ ok: true, value: "above" });
		expect(decodeValue(placement, "invalid")).toEqual({
			ok: false,
			error: "expected one of: Above editor, Below editor",
		});
		expect(decodeValue(placement, 1)).toEqual({ ok: false, error: "expected an option" });
		expect(validateValue(placement, "nope")).toEqual({ ok: false, error: '"nope" is not one of: above, below' });
		expect(validateValue(placement, true as never)).toMatchObject({
			ok: false,
			error: "expected an option, got true",
		});
		expect(
			formatValue(
				{ key: "mode", label: "Mode", type: "select", default: "raw", options: [{ value: "raw" }] },
				"raw",
			),
		).toBe("raw");
	});

	it("normalizes color values and rejects non-hex input", () => {
		const field: SettingField = { key: "background", label: "Background", type: "color", default: "#ffb3b3" };
		expect(validateSpec({ ...spec, fields: [field] })).toBeUndefined();
		expect(decodeValue(field, "#ABC")).toEqual({ ok: true, value: "#aabbcc" });
		expect(decodeValue(field, " #AABBCC ")).toEqual({ ok: true, value: "#aabbcc" });
		expect(decodeValue(field, "none")).toEqual({ ok: true, value: "none" });
		expect(decodeValue(field, "red")).toEqual({ ok: false, error: 'expected "none" or a hex color like #ffb3b3' });
		expect(decodeValue(field, 1)).toEqual({ ok: false, error: "expected a color" });
		expect(validateValue(field, "#FFB3B3")).toEqual({ ok: true, value: "#ffb3b3" });
		expect(validateValue(field, "red")).toEqual({ ok: false, error: 'expected "none" or a hex color like #ffb3b3' });
		expect(validateValue(field, 1 as never)).toMatchObject({ ok: false, error: "expected a color, got 1" });
		expect(formatValue(field, "none")).toBe("none");
		expect(formatValue(field, "#ffb3b3")).toBe("#ffb3b3");
		expect(cycleValues(field)).toBeUndefined();
		expect(cycleToValue(field, "#ffb3b3")).toBeUndefined();
	});

	it("formats and cycles values with human-readable labels", () => {
		const booleanField = spec.fields[0];
		const numberField = spec.fields[1];
		const selectField = spec.fields[3];
		expect(formatValue(booleanField, false)).toBe("off");
		expect(formatValue(numberField, 7)).toBe("7 rows");
		expect(formatValue(selectField, "above")).toBe("Above editor");
		expect(cycleValues(booleanField)).toEqual(["on", "off"]);
		expect(cycleToValue(booleanField, "on")).toBe(true);
		expect(cycleToValue(booleanField, "off")).toBe(false);
		expect(cycleToValue(booleanField, "invalid")).toBeUndefined();
		expect(formatValue(spec.fields[2], "")).toBe("(empty)");
		expect(cycleValues(selectField)).toEqual(["Above editor", "Below editor"]);
		expect(cycleToValue(selectField, "Below editor")).toBe("below");
		expect(cycleToValue(spec.fields[2], "text")).toBeUndefined();
		expect(validateValue(numberField, 4.5)).toEqual({ ok: false, error: "must be a whole number" });
		expect(validateValue(selectField, "missing").ok).toBe(false);
		expect(isChanged(numberField, undefined)).toBe(false);
		expect(isChanged(numberField, 6)).toBe(true);
		expect(isChanged(numberField, 5)).toBe(false);
	});
});
