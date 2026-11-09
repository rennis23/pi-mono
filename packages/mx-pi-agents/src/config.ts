/**
 * Durable extension config: `<agentDir>/extensions/mx-pi-agents.json`.
 *
 * The file is the source of truth at session start. It stores extra agent
 * search paths and the approval ledger for gated definitions. Writes are atomic
 * (temp + rename) so a crash mid-write cannot leave a half-parsed file that
 * would silently drop approvals.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentDiagnostic } from "./types.js";

export const CONFIG_FILE_NAME = "mx-pi-agents.json";
export const CONFIG_VERSION = 1;
export const APPROVAL_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** One approved gated definition: the hash the operator approved. */
export interface ApprovalEntry {
	/** SHA-256 of the definition file at approval time. */
	hash: string;
	/** Source kind at approval time (`config` or `project`). */
	kind: string;
	/** Epoch ms of approval. */
	approvedAt: number;
}

/** Approvals keyed by real directory of the definition file. */
export type ApprovalLedger = Record<string, Record<string, ApprovalEntry>>;

export interface AgentsConfig {
	version: number;
	/** Extra directories to search for definitions (gated). */
	agentPaths: string[];
	/** Approval ledger: real dir → file name → approved hash. */
	approvals: ApprovalLedger;
}

export interface ConfigStore {
	/** Absolute path of the config file. */
	readonly path: string;
	/** Load the config, falling back to defaults on any failure. */
	load(): { config: AgentsConfig; diagnostics: AgentDiagnostic[] };
	/** Persist a config atomically. Throws on I/O failure. */
	save(config: AgentsConfig): void;
}

export function defaultConfig(): AgentsConfig {
	return { version: CONFIG_VERSION, agentPaths: [], approvals: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a raw config object defensively: every field is optional, every wrong
 * type is dropped with a diagnostic, and the result is always usable.
 */
export function parseConfig(raw: unknown, diagnostics: AgentDiagnostic[]): AgentsConfig {
	const config = defaultConfig();
	if (!isPlainObject(raw)) {
		diagnostics.push({ level: "warning", message: "config is not a JSON object; using defaults" });
		return config;
	}

	if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
		diagnostics.push({
			level: "info",
			message: `config version ${String(raw.version)} is not ${CONFIG_VERSION}; unknown fields are ignored`,
		});
	}

	config.agentPaths = parseAgentPaths(raw.agentPaths, diagnostics);
	config.approvals = parseApprovals(raw.approvals, diagnostics);
	return config;
}

function parseAgentPaths(raw: unknown, diagnostics: AgentDiagnostic[]): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		diagnostics.push({ level: "warning", message: "config agentPaths is not a list; ignored" });
		return [];
	}
	const paths: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			diagnostics.push({ level: "warning", message: "config agentPaths contains a non-string entry; ignored" });
			continue;
		}
		paths.push(entry.trim());
	}
	return paths;
}

function parseApprovals(raw: unknown, diagnostics: AgentDiagnostic[]): ApprovalLedger {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) {
		diagnostics.push({ level: "warning", message: "config approvals is not an object; ignored" });
		return {};
	}
	const approvals: ApprovalLedger = {};
	for (const [dir, files] of Object.entries(raw)) {
		if (!isPlainObject(files)) {
			diagnostics.push({ level: "warning", message: `approvals for ${dir} are not an object; ignored` });
			continue;
		}
		const approved: Record<string, ApprovalEntry> = {};
		for (const [file, entry] of Object.entries(files)) {
			if (!isPlainObject(entry) || typeof entry.hash !== "string" || entry.hash.length === 0) {
				diagnostics.push({ level: "warning", message: `approval for ${file} is malformed; ignored` });
				continue;
			}
			approved[file] = {
				hash: entry.hash,
				kind: typeof entry.kind === "string" ? entry.kind : "project",
				approvedAt: typeof entry.approvedAt === "number" ? entry.approvedAt : 0,
			};
		}
		approvals[dir] = approved;
	}
	return approvals;
}

/** Serialize a config deterministically (stable key order, trailing newline). */
export function serializeConfig(config: AgentsConfig): string {
	const approvals: ApprovalLedger = {};
	const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	for (const dir of Object.keys(config.approvals).sort(byName)) {
		const files = config.approvals[dir];
		const sorted: Record<string, ApprovalEntry> = {};
		for (const file of Object.keys(files).sort(byName)) sorted[file] = files[file];
		approvals[dir] = sorted;
	}
	return `${JSON.stringify(
		{
			version: CONFIG_VERSION,
			agentPaths: config.agentPaths,
			approvals,
		},
		null,
		"\t",
	)}\n`;
}

/** Resolve an `agentPaths` entry against the config file's directory. */
export function resolveAgentPath(entry: string, baseDir: string): string {
	let expanded = entry;
	if (entry === "~") expanded = process.env.HOME ?? baseDir;
	else if (entry.startsWith("~/")) expanded = join(process.env.HOME ?? baseDir, entry.slice(2));
	return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/**
 * Create the config store. `agentDir` is injectable so tests never touch the
 * real `~/.pi`; production callers pass nothing and get `getAgentDir()`.
 */
export function createConfigStore(agentDir?: string): ConfigStore {
	const dir = agentDir ?? getAgentDir();
	const path = join(dir, "extensions", CONFIG_FILE_NAME);

	return {
		path,

		load() {
			const diagnostics: AgentDiagnostic[] = [];
			// Open once and stat/read through the same descriptor so a concurrent
			// replace cannot slip between an existence check and the read (TOCTOU).
			let fd: number | undefined;
			try {
				fd = openSync(path, "r");
				const stats = fstatSync(fd);
				if (!stats.isFile()) {
					diagnostics.push({ level: "warning", message: `${path} is not a regular file; using defaults`, path });
					return { config: defaultConfig(), diagnostics };
				}
				const raw = JSON.parse(readFileSync(fd, "utf8"));
				const config = parseConfig(raw, diagnostics);
				const baseDir = dirname(path);
				config.agentPaths = config.agentPaths.map((entry) => resolveAgentPath(entry, baseDir));
				return { config, diagnostics };
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { config: defaultConfig(), diagnostics };
				diagnostics.push({
					level: "warning",
					message: `could not read ${path} (${err instanceof Error ? err.message : String(err)}); using defaults`,
					path,
				});
				return { config: defaultConfig(), diagnostics };
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		},

		save(config: AgentsConfig) {
			const base = dirname(path);
			mkdirSync(base, { recursive: true, mode: 0o700 });
			const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
			try {
				writeFileSync(temp, serializeConfig(config), { encoding: "utf8", mode: 0o600 });
				renameSync(temp, path);
			} catch (err) {
				try {
					rmSync(temp, { force: true });
				} catch {
					/* best-effort cleanup */
				}
				throw err;
			}
		},
	};
}
