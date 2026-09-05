/**
 * Persistent config store for mx-pi-context-stats options.
 *
 * Options live in the extension's own JSON file under
 * `<agentDir>/extensions/mx-pi-context-stats.json`, the same convention other
 * pi extensions use (e.g. pi-vision.json). The file is the single source of
 * truth: it is read on session start (CLI flags still win for the current
 * run) and written back whenever an option changes via `/mx-pi-settings`.
 *
 * The store is plain data with no pi types, and the file path is injectable,
 * so it can be exercised against a temp directory without loading pi's TUI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ContextStatsOptions, DEFAULT_OPTIONS, withOptions } from "./options.js";
import type { StatsPlacement } from "./types.js";

export const CONFIG_FILE_NAME = "mx-pi-context-stats.json";

/** `<agentDir>/extensions/mx-pi-context-stats.json` (agentDir honors PI_CODING_AGENT_DIR). */
export function getConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

const VALID_PLACEMENTS: StatsPlacement[] = ["aboveEditor", "belowEditor"];

/** Numeric option keys; `withOptions`/`clampInt` bound the parsed values. */
const NUMBER_KEYS = ["historyRows", "subagentRows", "maxWidgetLines"] as const;
/** Boolean option keys. */
const BOOLEAN_KEYS = ["showSubagents", "showHealth", "visible"] as const;

type NumberKey = (typeof NUMBER_KEYS)[number];
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

function pickNumber(raw: Record<string, unknown>, key: NumberKey): number | undefined {
	const value = raw[key];
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const n = typeof value === "number" ? value : Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}

function pickBoolean(raw: Record<string, unknown>, key: BooleanKey): boolean | undefined {
	const value = raw[key];
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Keep only the values `ContextStatsOptions` can actually hold. `withOptions`
 * clamps numbers but assigns `placement` verbatim, so an invalid placement
 * from a hand-edited file is filtered here instead of reaching the widget.
 * Unknown keys are dropped; numbers and booleans pass through for
 * `withOptions` to coerce and bound.
 */
function sanitize(raw: Record<string, unknown>): Partial<ContextStatsOptions> {
	const patch: Partial<ContextStatsOptions> = {};
	for (const key of NUMBER_KEYS) {
		const value = pickNumber(raw, key);
		if (value !== undefined) patch[key] = value;
	}
	for (const key of BOOLEAN_KEYS) {
		const value = pickBoolean(raw, key);
		if (value !== undefined) patch[key] = value;
	}
	const placement = raw.placement;
	if (typeof placement === "string" && VALID_PLACEMENTS.includes(placement as StatsPlacement)) {
		patch.placement = placement as StatsPlacement;
	}
	if (Array.isArray(raw.subagentToolNames)) {
		patch.subagentToolNames = raw.subagentToolNames.filter((name): name is string => typeof name === "string");
	}
	return patch;
}

/** Read and parse the config file. Any failure (missing, unreadable, malformed) yields `{}`. */
function readConfigFile(path: string): Partial<ContextStatsOptions> {
	let parsed: unknown;
	try {
		if (!existsSync(path)) return {};
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	return sanitize(parsed as Record<string, unknown>);
}

export interface ConfigStore {
	/** Absolute path this store reads and writes. */
	readonly path: string;
	/**
	 * Merge the config file over `base`. A missing, unreadable, or malformed
	 * file yields `base` unchanged: bad config can never block startup.
	 */
	resolve(base?: ContextStatsOptions): ContextStatsOptions;
	/** Persist `options` (pretty JSON). Throws on I/O failure; callers notify. */
	save(options: ContextStatsOptions): void;
}

export function createConfigStore(path: string = getConfigPath()): ConfigStore {
	return {
		path,
		resolve(base: ContextStatsOptions = DEFAULT_OPTIONS): ContextStatsOptions {
			return withOptions(base, readConfigFile(path));
		},
		save(options: ContextStatsOptions): void {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(options, null, "\t")}\n`, "utf8");
		},
	};
}
