/**
 * CLI flag names and shared assignment parsing. Both the hub and every provider
 * use this parser so a run-scoped override has identical semantics everywhere.
 */

import type { SettingPrimitive } from "./types.js";

export const SETTINGS_FLAGS = {
	open: "mx-pi-settings-open",
	set: "mx-pi-settings-set",
	store: "mx-pi-settings-store",
} as const;

export interface Assignment {
	id: string;
	key: string;
	value: string;
}

export interface AssignmentParseResult {
	assignments: Assignment[];
	errors: string[];
}

/**
 * Split comma-delimited assignments while allowing a quoted value to contain a
 * comma: `id.key="one,two",other.enabled=true`.
 */
function splitAssignments(input: string): { pieces: string[]; unclosedQuote: boolean } {
	const pieces: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== undefined) {
			escaped = true;
			continue;
		}
		if ((char === '"' || char === "'") && (quote === undefined || quote === char)) {
			quote = quote === undefined ? char : undefined;
			current += char;
			continue;
		}
		if (char === "," && quote === undefined) {
			pieces.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	pieces.push(current.trim());
	return { pieces, unclosedQuote: quote !== undefined };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).replace(/\\([\\"'])/g, "$1");
	}
	return trimmed;
}

/** Parse `extension-id.key=value[,extension-id.key=value…]`. */
export function parseAssignments(input: string): AssignmentParseResult {
	const assignments: Assignment[] = [];
	const errors: string[] = [];
	const { pieces, unclosedQuote } = splitAssignments(input);
	if (unclosedQuote) {
		errors.push("unclosed quote in assignment list");
		pieces.pop(); // Ignore the unfinished final assignment; earlier ones remain usable.
	}
	for (const piece of pieces) {
		if (!piece) continue;
		const equals = piece.indexOf("=");
		if (equals <= 0) {
			errors.push(`expected id.key=value, got "${piece}"`);
			continue;
		}
		const path = piece.slice(0, equals).trim();
		const value = unquote(piece.slice(equals + 1));
		const dot = path.indexOf(".");
		if (dot <= 0 || dot === path.length - 1 || path.indexOf(".", dot + 1) !== -1) {
			errors.push(`expected one extension id and one key in "${path}"`);
			continue;
		}
		const id = path.slice(0, dot).trim();
		const key = path.slice(dot + 1).trim();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
			errors.push(`invalid id or key in "${path}"`);
			continue;
		}
		assignments.push({ id, key, value });
	}
	return { assignments, errors };
}

/** A parsed raw flag override; field-specific decoding happens at the SDK boundary. */
export interface RuntimeOverride {
	id: string;
	key: string;
	value: SettingPrimitive;
}

/** Resolve a flag value when pi's registerFlag API already typed it. */
export function parseFlagAssignments(value: string | boolean | undefined): AssignmentParseResult {
	if (typeof value !== "string" || value.trim() === "") return { assignments: [], errors: [] };
	return parseAssignments(value);
}
