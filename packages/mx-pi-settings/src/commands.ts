/** Scriptable command parser and registry operations, independent of the TUI. */

import { decodeValue, defaultValues, findField, formatValue } from "./fields.js";
import type { SettingsRegistry } from "./registry.js";
import type { RegistrationPayload, SettingPrimitive, SettingValues } from "./types.js";

export const SETTINGS_USAGE =
	"Usage: /mx-pi-settings [list [<id>]|get <id>[.<key>]|set <id>.<key> <value>|reset <id>[.<key>]|help]";

export type ParsedCommand =
	| { kind: "open" }
	| { kind: "help" }
	| { kind: "list"; id?: string }
	| { kind: "get"; id: string; key?: string }
	| { kind: "set"; id: string; key: string; value: string }
	| { kind: "reset"; id: string; key?: string }
	| { kind: "error"; message: string };

export interface CommandOutcome {
	text: string;
	type: "info" | "warning" | "error";
	openUI?: boolean;
}

function parseSettingPath(path: string): { id: string; key?: string } | undefined {
	const normalized = path.trim();
	const dot = normalized.indexOf(".");
	if (dot === -1) return /^[a-z0-9][a-z0-9-]*$/.test(normalized) ? { id: normalized } : undefined;
	if (dot === 0 || dot === normalized.length - 1 || normalized.indexOf(".", dot + 1) !== -1) return undefined;
	const id = normalized.slice(0, dot);
	const key = normalized.slice(dot + 1);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) return undefined;
	return { id, key };
}

/** Parse the command line without losing spaces in a string field's value. */
export function parseSettingsCommand(input: string): ParsedCommand {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "open" };
	const [command, ...rest] = trimmed.split(/\s+/);
	const argText = trimmed.slice(command.length).trim();
	switch (command.toLowerCase()) {
		case "help":
			return { kind: "help" };
		case "list": {
			if (!argText) return { kind: "list" };
			const path = parseSettingPath(argText);
			if (!path || path.key !== undefined)
				return { kind: "error", message: `list accepts an extension id only. ${SETTINGS_USAGE}` };
			return { kind: "list", id: path.id };
		}
		case "get": {
			const path = parseSettingPath(rest[0] ?? "");
			if (!path) return { kind: "error", message: `get needs an id or id.key. ${SETTINGS_USAGE}` };
			return { kind: "get", id: path.id, key: path.key };
		}
		case "set": {
			const match = /^([^\s]+)\s+([\s\S]+)$/.exec(argText);
			if (!match) return { kind: "error", message: `set needs id.key and a value. ${SETTINGS_USAGE}` };
			const path = parseSettingPath(match[1]);
			if (!path?.key) return { kind: "error", message: `set needs id.key. ${SETTINGS_USAGE}` };
			return { kind: "set", id: path.id, key: path.key, value: match[2] };
		}
		case "reset": {
			const path = parseSettingPath(rest[0] ?? "");
			if (!path) return { kind: "error", message: `reset needs an id or id.key. ${SETTINGS_USAGE}` };
			return { kind: "reset", id: path.id, key: path.key };
		}
		default:
			return { kind: "error", message: `Unknown command "${command}". ${SETTINGS_USAGE}` };
	}
}

function currentValues(registry: SettingsRegistry, registration: RegistrationPayload): SettingValues {
	const defaults = defaultValues(registration.spec);
	return { ...defaults, ...registry.read(registration) };
}

function missing(id: string): CommandOutcome {
	return { text: `No settings registered for "${id}".`, type: "warning" };
}

function listOne(registry: SettingsRegistry, registration: RegistrationPayload): string[] {
	const values = currentValues(registry, registration);
	const rows = [`${registration.spec.title} (${registration.spec.id})`];
	if (registration.spec.description) rows.push(`  ${registration.spec.description}`);
	for (const field of registration.spec.fields) {
		const value = values[field.key] ?? field.default;
		rows.push(`  ${field.key}: ${formatValue(field, value as SettingPrimitive)}`);
	}
	return rows;
}

/** Run one parsed command. It invokes only the already-guarded registry facade. */
export function executeSettingsCommand(parsed: ParsedCommand, registry: SettingsRegistry): CommandOutcome {
	switch (parsed.kind) {
		case "open":
			return { text: "", type: "info", openUI: true };
		case "help":
			return { text: SETTINGS_USAGE, type: "info" };
		case "list": {
			const registrations = registry
				.list()
				.filter((registration) => parsed.id === undefined || registration.spec.id === parsed.id);
			if (parsed.id !== undefined && registrations.length === 0) return missing(parsed.id);
			if (registrations.length === 0) return { text: "No extensions have registered settings.", type: "info" };
			return {
				text: registrations.flatMap((registration) => listOne(registry, registration)).join("\n"),
				type: "info",
			};
		}
		case "get": {
			const registration = registry.get(parsed.id);
			if (!registration) return missing(parsed.id);
			if (parsed.key === undefined) return { text: listOne(registry, registration).join("\n"), type: "info" };
			const field = findField(registration.spec, parsed.key);
			if (!field) return { text: `Unknown setting "${parsed.id}.${parsed.key}".`, type: "warning" };
			const values = currentValues(registry, registration);
			return {
				text: `${parsed.id}.${parsed.key}=${formatValue(field, (values[parsed.key] ?? field.default) as SettingPrimitive)}`,
				type: "info",
			};
		}
		case "set": {
			const registration = registry.get(parsed.id);
			if (!registration) return missing(parsed.id);
			const field = findField(registration.spec, parsed.key);
			if (!field) return { text: `Unknown setting "${parsed.id}.${parsed.key}".`, type: "warning" };
			const decoded = decodeValue(field, parsed.value);
			if (!decoded.ok) {
				return {
					text: `Invalid value for ${parsed.id}.${parsed.key}: ${decoded.error}`,
					type: "warning",
				};
			}
			const result = registry.write(registration, parsed.key, decoded.value);
			if (!result.ok)
				return { text: `Could not update ${parsed.id}.${parsed.key}: ${result.error}`, type: "warning" };
			const effectiveValue = result.values[parsed.key] ?? field.default;
			return {
				text: `${parsed.id}.${parsed.key}=${formatValue(field, effectiveValue as SettingPrimitive)}`,
				type: "info",
			};
		}
		case "reset": {
			const registration = registry.get(parsed.id);
			if (!registration) return missing(parsed.id);
			if (parsed.key !== undefined && !findField(registration.spec, parsed.key)) {
				return { text: `Unknown setting "${parsed.id}.${parsed.key}".`, type: "warning" };
			}
			const result = registry.reset(registration, parsed.key);
			if (!result.ok) return { text: `Could not reset ${parsed.id}: ${result.error}`, type: "warning" };
			return {
				text: parsed.key ? `Reset ${parsed.id}.${parsed.key}.` : `Reset ${parsed.id} to defaults.`,
				type: "info",
			};
		}
		case "error":
			return { text: parsed.message, type: "warning" };
	}
}
