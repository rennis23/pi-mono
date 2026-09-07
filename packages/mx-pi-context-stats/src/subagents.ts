/**
 * Tolerant parsing of subagent tool payloads.
 *
 * pi exposes `tool_execution_start` args, `partialResult` updates and final
 * results as untyped data, and different subagent implementations (pi's own
 * subagent tool, maister-style spawners, custom forks) report usage in
 * different shapes. Rather than coupling to one producer, this module reduces
 * any of those shapes to a `SubagentPatch`, and never throws: an unrecognized
 * payload yields an empty patch, which the caller treats as "nothing new".
 */

import type { SubagentInfo, SubagentPatch } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First value in `values` that is a finite number. */
function num(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return undefined;
}

/** First value in `values` that is a non-empty string. */
function str(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/** First value in `values` that is a non-empty array of strings. */
function strList(...values: unknown[]): string[] | undefined {
	for (const v of values) {
		if (Array.isArray(v) && v.length > 0 && v.every((item) => typeof item === "string")) {
			return v as string[];
		}
	}
	return undefined;
}

const USAGE_KEYS = [
	"turns",
	"turnCount",
	"input",
	"inputTokens",
	"output",
	"outputTokens",
	"totalTokens",
	"contextTokens",
	"context",
	"cost",
	"totalCost",
];

function looksLikeUsage(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && USAGE_KEYS.some((key) => value[key] !== undefined);
}

/**
 * Locate the usage object in a payload. Accepted layouts:
 * `{ details: { usage } }`, `{ usage }`, `{ details }` carrying usage directly,
 * or usage fields at the top level.
 */
function pickUsage(raw: unknown): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;
	const details = isRecord(raw.details) ? raw.details : undefined;
	for (const candidate of [details?.usage, raw.usage, details, raw]) {
		if (looksLikeUsage(candidate)) return candidate;
	}
	return undefined;
}

function pickCost(usage: Record<string, unknown>): number | undefined {
	const cost = usage.cost;
	if (isRecord(cost)) return num(cost.total, cost.amount);
	return num(cost, usage.totalCost);
}

/**
 * Reduce an arbitrary progress/result payload to normalized fields.
 * Returns `{}` when nothing recognizable is present.
 */
export function parseSubagentPayload(raw: unknown): SubagentPatch {
	const patch: SubagentPatch = {};
	if (!isRecord(raw)) return patch;

	const usage = pickUsage(raw);
	if (usage) {
		const turns = num(usage.turns, usage.turnCount);
		const input = num(usage.input, usage.inputTokens);
		const output = num(usage.output, usage.outputTokens);
		const context = num(usage.totalTokens, usage.contextTokens, usage.context);
		const cost = pickCost(usage);
		// Only attach `usage` when at least one field resolved: an empty usage
		// object would otherwise zero out good data on a final payload.
		if (
			turns !== undefined ||
			input !== undefined ||
			output !== undefined ||
			context !== undefined ||
			cost !== undefined
		) {
			patch.usage = { turns, input, output, context, cost };
		}
	}

	const details = isRecord(raw.details) ? raw.details : undefined;
	const model = str(details?.model, raw.model, details?.modelName);
	if (model !== undefined) patch.model = model;

	const tools = strList(details?.toolsUsed, raw.tools, details?.tools, raw.toolsUsed);
	if (tools !== undefined) patch.tools = tools;

	return patch;
}

/** Pull the agent name and tool list out of a spawn tool's arguments. */
export function parseSpawnArgs(raw: unknown): { agentName: string; tools: string[] } {
	if (!isRecord(raw)) return { agentName: "unknown", tools: [] };
	const agentName = str(raw.agent_name, raw.agentName, raw.agent, raw.name) ?? "unknown";
	const tools = strList(raw.tools, raw.toolsUsed) ?? [];
	return { agentName, tools };
}

/**
 * Merge `patch` into a tracked subagent.
 *
 * Streaming updates (`final === false`) merge present fields only, so a partial
 * payload can never clobber known-good values back to 0. Final results
 * (`final === true`) are authoritative and replace usage wholesale, matching the
 * producer's complete end-of-run snapshot.
 */
export function applySubagentPatch(info: SubagentInfo, patch: SubagentPatch, final = false): void {
	if (patch.usage) {
		const u = patch.usage;
		if (final) {
			info.turns = u.turns ?? 0;
			info.inputTokens = u.input ?? 0;
			info.outputTokens = u.output ?? 0;
			info.contextTokens = u.context ?? 0;
			info.cost = u.cost ?? 0;
		} else {
			if (u.turns !== undefined) info.turns = u.turns;
			if (u.input !== undefined) info.inputTokens = u.input;
			if (u.output !== undefined) info.outputTokens = u.output;
			if (u.context !== undefined) info.contextTokens = u.context;
			if (u.cost !== undefined) info.cost = u.cost;
		}
	}

	// Model and tools are "fill in the blank" during streaming (they never
	// change mid-run) but authoritative on the final payload.
	if (patch.model !== undefined && (final || !info.model)) info.model = patch.model;
	if (patch.tools !== undefined && patch.tools.length > 0 && (final || info.tools.length === 0)) {
		info.tools = patch.tools;
	}
}
