/**
 * Field semantics: defaults, decoding, range checking, and display formatting.
 *
 * Text is the only shape that arrives from the outside world — the TUI editor,
 * `/mx-pi-settings set …`, and the JSON store all hand us strings. Every one of
 * those paths funnels through {@link decodeValue} so a field's contract (bounds,
 * select membership, length) is enforced in exactly one place, and everything
 * downstream can assume the value already matches its declared type.
 */

import type { SelectOption, SelectSettingField, SettingField, SettingPrimitive, SettingsSpec } from "./types.js";

export const SETTING_TYPES = ["boolean", "number", "string", "select", "color"] as const;

/** The literal that switches a color field off. */
export const NO_COLOR = "none";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

const TRUE_LITERALS = ["true", "on", "yes", "1"];
const FALSE_LITERALS = ["false", "off", "no", "0"];

/** Maximum characters accepted for a string field when the spec does not cap it. */
export const DEFAULT_MAX_STRING_LENGTH = 512;

export type DecodeResult = { ok: true; value: SettingPrimitive } | { ok: false; error: string };

function fail(error: string): DecodeResult {
	return { ok: false, error };
}

function succeed(value: SettingPrimitive): DecodeResult {
	return { ok: true, value };
}

export function optionLabel(option: SelectOption): string {
	return option.label ?? option.value;
}

export function optionValue(field: SelectSettingField, label: string): string | undefined {
	return field.options.find((option) => optionLabel(option) === label)?.value;
}

/**
 * Normalize `#abc` / `#AABBCC` to lower-case `#aabbcc`, pass `none` through, and
 * return `undefined` for anything else. The single place that decides what a
 * color field accepts.
 */
export function normalizeColor(raw: string): string | undefined {
	const text = raw.trim().toLowerCase();
	if (text === NO_COLOR) return NO_COLOR;
	if (!HEX_COLOR_PATTERN.test(text)) return undefined;
	if (text.length === 4) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
	return text;
}

/**
 * Structural validation of a whole spec.
 *
 * Returns the first problem found, or `undefined` when the spec is usable. This
 * runs before a registration is accepted so a broken provider degrades to a
 * warning instead of breaking the hub's render loop.
 */
export function validateSpec(spec: Pick<SettingsSpec, "id" | "title" | "fields">): string | undefined {
	if (typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) {
		return `invalid id "${String(spec.id)}": use lower-case letters, digits and dashes`;
	}
	if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
		return "missing title";
	}
	if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
		return "no fields declared";
	}
	const seen = new Set<string>();
	for (const field of spec.fields) {
		const problem = validateField(field);
		if (problem !== undefined) return problem;
		if (seen.has(field.key)) return `duplicate field key "${field.key}"`;
		seen.add(field.key);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateField(field: unknown): string | undefined {
	if (!isRecord(field)) return "field must be an object";
	const key = field.key;
	if (typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
		return `invalid field key "${String(key)}"`;
	}
	if (typeof field.label !== "string" || field.label.trim().length === 0) return `field "${key}": missing label`;
	switch (field.type) {
		case "boolean":
			if (typeof field.default !== "boolean") return `field "${key}": default must be a boolean`;
			if (field.trueLabel !== undefined && typeof field.trueLabel !== "string") {
				return `field "${key}": trueLabel must be a string`;
			}
			if (field.falseLabel !== undefined && typeof field.falseLabel !== "string") {
				return `field "${key}": falseLabel must be a string`;
			}
			if ((field.trueLabel ?? "on") === (field.falseLabel ?? "off")) {
				return `field "${key}": boolean labels must differ`;
			}
			return undefined;
		case "number": {
			if (typeof field.default !== "number" || !Number.isFinite(field.default)) {
				return `field "${key}": default must be a finite number`;
			}
			if (field.min !== undefined && (typeof field.min !== "number" || !Number.isFinite(field.min))) {
				return `field "${key}": min must be a finite number`;
			}
			if (field.max !== undefined && (typeof field.max !== "number" || !Number.isFinite(field.max))) {
				return `field "${key}": max must be a finite number`;
			}
			if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
				return `field "${key}": min is greater than max`;
			}
			if (field.integer !== undefined && typeof field.integer !== "boolean") {
				return `field "${key}": integer must be a boolean`;
			}
			if (field.integer === true && !Number.isInteger(field.default)) {
				return `field "${key}": default must be a whole number`;
			}
			if (field.min !== undefined && field.default < field.min) return `field "${key}": default is below min`;
			if (field.max !== undefined && field.default > field.max) return `field "${key}": default is above max`;
			return undefined;
		}
		case "string": {
			if (typeof field.default !== "string") return `field "${key}": default must be a string`;
			if (
				field.maxLength !== undefined &&
				(typeof field.maxLength !== "number" || !Number.isSafeInteger(field.maxLength) || field.maxLength < 1)
			) {
				return `field "${key}": maxLength must be a positive integer`;
			}
			const maxLength = typeof field.maxLength === "number" ? field.maxLength : DEFAULT_MAX_STRING_LENGTH;
			if (field.default.length > maxLength) {
				return `field "${key}": default exceeds maxLength`;
			}
			if (field.placeholder !== undefined && typeof field.placeholder !== "string") {
				return `field "${key}": placeholder must be a string`;
			}
			return undefined;
		}
		case "color": {
			if (typeof field.default !== "string") return `field "${key}": default must be a string`;
			if (normalizeColor(field.default) !== field.default) {
				return `field "${key}": default must be "none" or a lower-case #rrggbb color`;
			}
			if (field.placeholder !== undefined && typeof field.placeholder !== "string") {
				return `field "${key}": placeholder must be a string`;
			}
			return undefined;
		}
		case "select": {
			if (typeof field.default !== "string") return `field "${key}": default must be a string`;
			if (!Array.isArray(field.options) || field.options.length === 0) {
				return `field "${key}": select needs at least one option`;
			}
			const values: string[] = [];
			const labels: string[] = [];
			for (const option of field.options) {
				if (!isRecord(option) || typeof option.value !== "string" || option.value.length === 0) {
					return `field "${key}": each option needs a non-empty string value`;
				}
				if (option.label !== undefined && typeof option.label !== "string") {
					return `field "${key}": option labels must be strings`;
				}
				values.push(option.value);
				labels.push(typeof option.label === "string" ? option.label : option.value);
			}
			if (new Set(values).size !== values.length) return `field "${key}": duplicate option value`;
			if (new Set(labels).size !== labels.length) return `field "${key}": duplicate option label`;
			return values.includes(field.default)
				? undefined
				: `field "${key}": default "${field.default}" is not one of its options`;
		}
		default:
			return `field "${key}": unknown type "${String(field.type)}"`;
	}
}

/** `{ key: defaultValue }` for every declared field. */
export function defaultValues(spec: Pick<SettingsSpec, "fields">): Record<string, SettingPrimitive> {
	const values: Record<string, SettingPrimitive> = {};
	for (const field of spec.fields) values[field.key] = field.default;
	return values;
}

export function findField(spec: Pick<SettingsSpec, "fields">, key: string): SettingField | undefined {
	return spec.fields.find((field) => field.key === key);
}

/**
 * Turn an already-typed value into something storable, checking bounds and
 * membership. Used by every mutation path (`set`, UI cycling, resets).
 */
export function validateValue(field: SettingField, value: SettingPrimitive): DecodeResult {
	switch (field.type) {
		case "boolean":
			return typeof value === "boolean" ? succeed(value) : fail(`expected true|false, got ${formatUnknown(value)}`);
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return fail(`expected a number, got ${formatUnknown(value)}`);
			}
			return validateNumber(field, value);
		}
		case "string": {
			if (typeof value !== "string") return fail(`expected text, got ${formatUnknown(value)}`);
			const maxLength = field.maxLength ?? DEFAULT_MAX_STRING_LENGTH;
			if (value.length > maxLength) return fail(`must be at most ${maxLength} characters`);
			return succeed(value);
		}
		case "color": {
			if (typeof value !== "string") return fail(`expected a color, got ${formatUnknown(value)}`);
			const normalized = normalizeColor(value);
			if (normalized === undefined) return fail(`expected "none" or a hex color like #ffb3b3`);
			return succeed(normalized);
		}
		case "select": {
			if (typeof value !== "string") return fail(`expected an option, got ${formatUnknown(value)}`);
			if (!field.options.some((option) => option.value === value)) {
				return fail(`"${value}" is not one of: ${field.options.map((option) => option.value).join(", ")}`);
			}
			return succeed(value);
		}
	}
}

function validateNumber(field: Extract<SettingField, { type: "number" }>, value: number): DecodeResult {
	if (field.integer === true && !Number.isInteger(value)) return fail("must be a whole number");
	if (field.min !== undefined && value < field.min) return fail(`must be at least ${field.min}`);
	if (field.max !== undefined && value > field.max) return fail(`must be at most ${field.max}`);
	return succeed(value);
}

/**
 * Decode raw input (a string from text input, or a value read back from JSON)
 * into the field's type, then apply its constraints.
 */
export function decodeValue(field: SettingField, raw: unknown): DecodeResult {
	switch (field.type) {
		case "boolean": {
			if (typeof raw === "boolean") return succeed(raw);
			if (typeof raw === "number") {
				if (raw === 1) return succeed(true);
				if (raw === 0) return succeed(false);
				return fail("expected true|false");
			}
			if (typeof raw !== "string") return fail("expected true|false");
			const normalized = raw.trim().toLowerCase();
			if (TRUE_LITERALS.includes(normalized)) return succeed(true);
			if (FALSE_LITERALS.includes(normalized)) return succeed(false);
			return fail(`expected one of ${[...TRUE_LITERALS, ...FALSE_LITERALS].join(", ")}`);
		}
		case "number": {
			const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
			if (!Number.isFinite(numeric)) return fail("expected a number");
			return validateNumber(field, numeric);
		}
		case "string": {
			if (typeof raw !== "string") return fail("expected text");
			const trimmed = raw.trim();
			const maxLength = field.maxLength ?? DEFAULT_MAX_STRING_LENGTH;
			if (trimmed.length > maxLength) return fail(`must be at most ${maxLength} characters`);
			return succeed(trimmed);
		}
		case "color": {
			if (typeof raw !== "string") return fail("expected a color");
			const normalized = normalizeColor(raw);
			if (normalized === undefined) return fail(`expected "none" or a hex color like #ffb3b3`);
			return succeed(normalized);
		}
		case "select": {
			if (typeof raw !== "string") return fail("expected an option");
			const normalized = raw.trim();
			if (field.options.some((option) => option.value === normalized)) return succeed(normalized);
			const byLabel = optionValue(field, normalized);
			if (byLabel !== undefined) return succeed(byLabel);
			return fail(`expected one of: ${field.options.map(optionLabel).join(", ")}`);
		}
	}
}

function formatUnknown(value: unknown): string {
	return typeof value === "string" ? `"${value}"` : String(value);
}

/** Value rendered in a settings row, e.g. `on`, `6 rows`, `below editor`. */
export function formatValue(field: SettingField, value: SettingPrimitive): string {
	switch (field.type) {
		case "boolean":
			return value === true ? (field.trueLabel ?? "on") : (field.falseLabel ?? "off");
		case "number": {
			const suffix = field.unit === undefined ? "" : ` ${field.unit}`;
			return `${String(value)}${suffix}`;
		}
		case "select":
			return optionLabel(field.options.find((option) => option.value === value) ?? { value: String(value) });
		case "color": {
			const text = typeof value === "string" ? value : String(value);
			return text.length === 0 ? NO_COLOR : text;
		}
		case "string": {
			const text = typeof value === "string" ? value : String(value);
			return text.length === 0 ? "(empty)" : text;
		}
	}
}

/** Values accepted by a row that cycles on Enter/Space (booleans and selects). */
export function cycleValues(field: SettingField): string[] | undefined {
	if (field.type === "boolean") {
		return [field.trueLabel ?? "on", field.falseLabel ?? "off"];
	}
	if (field.type === "select") {
		return field.options.map((option) => optionLabel(option) ?? option.value);
	}
	return undefined;
}

/** Translate a chosen cycle label back to a stored value. */
export function cycleToValue(field: SettingField, label: string): SettingPrimitive | undefined {
	if (field.type === "boolean") {
		const trueLabel = field.trueLabel ?? "on";
		const falseLabel = field.falseLabel ?? "off";
		if (label === trueLabel) return true;
		if (label === falseLabel) return false;
		return undefined;
	}
	if (field.type === "select") {
		return optionValue(field, label);
	}
	return undefined;
}

/** Whether a stored value differs from the field default (drives "N changed"). */
export function isChanged(field: SettingField, value: unknown): boolean {
	return typeof value !== "undefined" && value !== field.default;
}
