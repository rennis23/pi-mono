/**
 * Durable namespace store shared by the hub and provider SDK.
 *
 * The store treats its JSON document as untrusted. Reads are tolerant; writes
 * use a temp file and rename so an interrupted save does not truncate the last
 * valid document. Each namespace update first reads the latest whole document,
 * preserving every other extension's settings.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SettingPrimitive, SettingValues } from "./types.js";

export const STORE_FILE_NAME = "mx-pi-settings.json";
export const STORE_VERSION = 1;

export interface StoreDocument {
	version: number;
	values: Record<string, SettingValues>;
}

export interface SettingsStore {
	readonly path: string;
	readAll(): StoreDocument;
	readNamespace(id: string): SettingValues;
	writeNamespace(id: string, values: SettingValues): void;
	patchNamespace(id: string, patch: SettingValues): void;
	clearNamespace(id: string): void;
}

/** `<agentDir>/extensions/mx-pi-settings.json`; PI_CODING_AGENT_DIR is honored. */
export function getDefaultStorePath(): string {
	return join(getAgentDir(), "extensions", STORE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStoredValues(value: unknown): SettingValues {
	if (!isRecord(value)) return {};
	const result: SettingValues = {};
	for (const [key, item] of Object.entries(value)) {
		if (
			typeof item === "boolean" ||
			typeof item === "string" ||
			(typeof item === "number" && Number.isFinite(item))
		) {
			result[key] = item as SettingPrimitive;
		}
	}
	return result;
}

function emptyDocument(): StoreDocument {
	return { version: STORE_VERSION, values: {} };
}

function readDocument(path: string): StoreDocument {
	let parsed: unknown;
	try {
		if (!existsSync(path)) return emptyDocument();
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return emptyDocument();
	}
	if (!isRecord(parsed) || !isRecord(parsed.values)) return emptyDocument();
	const namespaces: Record<string, SettingValues> = {};
	for (const [id, values] of Object.entries(parsed.values)) {
		namespaces[id] = asStoredValues(values);
	}
	return {
		version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
		values: namespaces,
	};
}

function writeDocument(path: string, document: StoreDocument): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(document, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tempPath, path);
	} catch (error) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			// Preserve the original error; temp cleanup is best-effort.
		}
		throw error;
	}
}

/** Create a store. Pass a temp path in tests; production defaults under agentDir. */
export function createSettingsStore(path: string = getDefaultStorePath()): SettingsStore {
	return {
		path,
		readAll: () => readDocument(path),
		readNamespace(id: string): SettingValues {
			return { ...(readDocument(path).values[id] ?? {}) };
		},
		writeNamespace(id: string, values: SettingValues): void {
			const document = readDocument(path);
			document.values[id] = { ...values };
			writeDocument(path, document);
		},
		patchNamespace(id: string, patch: SettingValues): void {
			const document = readDocument(path);
			document.values[id] = { ...(document.values[id] ?? {}), ...patch };
			writeDocument(path, document);
		},
		clearNamespace(id: string): void {
			const document = readDocument(path);
			delete document.values[id];
			writeDocument(path, document);
		},
	};
}
