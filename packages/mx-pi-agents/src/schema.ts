/**
 * Agent definition schema.
 *
 * The schema is intentionally small and total: every field is validated, an
 * unknown field drops the definition, and errors carry a readable reason. The
 * effective-grant contract from the design (§4.4) lives here too, because it is
 * a pure function of the declaration plus the parent's tool set.
 */

import { parseFrontmatter } from "./frontmatter.js";
import { sanitizeUiText } from "./security.js";
import type { AgentDefinition, AgentDiagnostic, ThinkingLevel, ToolsInheritance } from "./types.js";

/** Name charset: lowercase slug, starts alphanumeric, max 64 chars. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Tool names come from pi (`read`, `mcp__srv__tool`, `mx_pi_agent`, …). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Model labels are `provider/model-id` or a bare model id. */
const MODEL_PATTERN = /^[A-Za-z0-9._/:-]{1,200}$/;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const MAX_MAX_TURNS = 1_000;
export const MAX_TIMEOUT_MS = 86_400_000;
export const MAX_TOKEN_BUDGET = 20_000_000;
export const MAX_COST_BUDGET = 1_000;
export const MAX_DESCRIPTION_CHARS = 512;

/** Tool names that can start another agent run; never inherited. */
export const DEFAULT_SPAWN_TOOL_NAMES: readonly string[] = [
	"mx_pi_agent",
	"subagent",
	"spawn_subagent",
	"subagent_task",
	"Task",
];

export type DefinitionParseResult = { ok: true; definition: AgentDefinition } | { ok: false; error: string };

function parseFailure(message: string): DefinitionParseResult {
	return { ok: false, error: message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a string field; absent/undefined returns undefined; wrong type fails. */
function readString(data: Record<string, unknown>, key: string, errors: string[]): string | undefined {
	const value = data[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		errors.push(`${key} must be a string`);
		return undefined;
	}
	return value.trim();
}

/** Read an integer field with bounds; out-of-range or non-int fails. */
function readInt(
	data: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
	errors: string[],
): number | undefined {
	const value = data[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		errors.push(`${key} must be an integer`);
		return undefined;
	}
	if (value < min || value > max) {
		errors.push(`${key} must be between ${min} and ${max}`);
		return undefined;
	}
	return value;
}

/** Read a finite number field with bounds (cost budgets can be fractional). */
function readNumber(
	data: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
	errors: string[],
): number | undefined {
	const value = data[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push(`${key} must be a number`);
		return undefined;
	}
	if (value < min || value > max) {
		errors.push(`${key} must be between ${min} and ${max}`);
		return undefined;
	}
	return value;
}

/** Read a string-list field, deduping while preserving order. */
function readToolList(data: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
	const value = data[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${key} must be a list of tool names`);
		return undefined;
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !TOOL_NAME_PATTERN.test(item.trim())) {
			errors.push(`${key} contains an invalid tool name`);
			return undefined;
		}
		const name = item.trim();
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"tools",
	"tools_inheritance",
	"model",
	"thinking",
	"max_turns",
	"timeout_ms",
	"token_budget",
	"cost_budget",
	"isolation",
	"sandbox",
]);

/**
 * Validate a frontmatter map into an `AgentDefinition`.
 *
 * Fails (drops the definition) on: missing/!valid name or description, unknown
 * fields, wrong value types, out-of-range numbers, and empty bodies. It never
 * defaults a capability: `tools` stays `undefined` when absent so the grant
 * contract can distinguish "absent" from "empty".
 */
export function definitionFromRaw(data: Record<string, unknown>): DefinitionParseResult {
	const errors: string[] = [];

	for (const key of Object.keys(data)) {
		if (!KNOWN_FIELDS.has(key)) errors.push(`unknown field "${sanitizeUiText(key, 40)}"`);
	}
	if (errors.length > 0) return parseFailure(`invalid agent definition: ${errors.join("; ")}`);

	const rawName = readString(data, "name", errors);
	if (rawName === undefined) errors.push("name is required");
	else if (!NAME_PATTERN.test(rawName)) {
		errors.push('name must match [a-z0-9][a-z0-9_-]{0,63} (lowercase letters, digits, "-", "_")');
	}

	const rawDescription = readString(data, "description", errors);
	if (rawDescription === undefined || rawDescription.length === 0) errors.push("description is required");
	else if (rawDescription.length > MAX_DESCRIPTION_CHARS) {
		errors.push(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
	}

	const tools = readToolList(data, "tools", errors);
	let toolsInheritance: ToolsInheritance = "none";
	if (data.tools_inheritance !== undefined && data.tools_inheritance !== null) {
		if (data.tools_inheritance === "none" || data.tools_inheritance === "parent") {
			toolsInheritance = data.tools_inheritance;
		} else {
			errors.push('tools_inheritance must be "none" or "parent"');
		}
	}

	const model = readString(data, "model", errors);
	if (model !== undefined && !MODEL_PATTERN.test(model)) errors.push("model contains invalid characters");

	let thinking: ThinkingLevel | undefined;
	if (data.thinking !== undefined && data.thinking !== null) {
		if (typeof data.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(data.thinking)) {
			thinking = data.thinking as ThinkingLevel;
		} else {
			errors.push(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
	}

	const maxTurns = readInt(data, "max_turns", 1, MAX_MAX_TURNS, errors);
	const timeoutMs = readInt(data, "timeout_ms", 1_000, MAX_TIMEOUT_MS, errors);
	const tokenBudget = readInt(data, "token_budget", 1_000, MAX_TOKEN_BUDGET, errors);
	const costBudget = readNumber(data, "cost_budget", 0, MAX_COST_BUDGET, errors);

	let isolation: AgentDefinition["isolation"] = "process";
	if (data.isolation !== undefined && data.isolation !== null) {
		if (data.isolation === "process" || data.isolation === "subprocess") {
			isolation = data.isolation;
		} else {
			errors.push('isolation must be "process" or "subprocess"');
		}
	}

	let sandbox: AgentDefinition["sandbox"] = "none";
	if (data.sandbox !== undefined && data.sandbox !== null) {
		if (data.sandbox === "none" || data.sandbox === "os") {
			sandbox = data.sandbox;
		} else {
			errors.push('sandbox must be "none" or "os"');
		}
	}

	if (errors.length > 0) return parseFailure(`invalid agent definition: ${errors.join("; ")}`);

	return {
		ok: true,
		definition: {
			name: rawName!,
			description: rawDescription!,
			tools,
			toolsInheritance,
			model,
			thinking,
			maxTurns,
			timeoutMs,
			tokenBudget,
			costBudget,
			isolation,
			sandbox,
			body: "",
		},
	};
}

/** Parse a definition file (frontmatter + body) into an `AgentDefinition`. */
export function parseAgentDefinition(content: string): DefinitionParseResult {
	const parsed = parseFrontmatter(content);
	if (!parsed.ok) return parseFailure(parsed.error);
	if (!isPlainObject(parsed.data)) return parseFailure("frontmatter must be a mapping");

	const result = definitionFromRaw(parsed.data);
	if (!result.ok) return result;
	if (parsed.body.length === 0) return parseFailure("definition body is empty");

	return { ok: true, definition: { ...result.definition, body: parsed.body } };
}

/** Options for computing a grant set. */
export interface GrantOptions {
	/** Tool names active in the parent session. */
	parentTools: readonly string[];
	/** Tool names that resolve inside the child (built-ins plus custom tools). */
	availableTools: readonly string[];
	/** Spawn-capable names excluded from inheritance. Defaults to the built-in list. */
	spawnToolNames?: readonly string[];
}

/** Effective grant set plus what a refusal decision needs. */
export interface GrantOutcome {
	/** Final grant set. For explicit grants this is the declared set, even when unresolved. */
	tools: string[];
	/** `"all"` when the grant set is empty, so the child starts with no tools. */
	noTools: "all" | undefined;
	/** Explicit names that do not resolve in the child; any entry means refuse. */
	unresolvedExplicit: string[];
	diagnostics: AgentDiagnostic[];
}

/**
 * Apply the total grant contract (§4.4):
 *
 * - `tools: [a, b]` → exactly `{a, b}`
 * - `tools: []` → ∅
 * - `tools` absent + `tools_inheritance: none` (default) → ∅
 * - `tools` absent + `tools_inheritance: parent` → parent tools minus spawn-capable names
 * - `tools_inheritance` is ignored when `tools` is present
 *
 * Nothing else can widen the grant: an empty result always becomes `noTools: "all"`.
 */
export function computeEffectiveTools(
	grant: Pick<AgentDefinition, "tools" | "toolsInheritance">,
	options: GrantOptions,
): GrantOutcome {
	const diagnostics: AgentDiagnostic[] = [];
	const available = new Set(options.availableTools);
	const spawn = new Set(options.spawnToolNames ?? DEFAULT_SPAWN_TOOL_NAMES);

	let tools: string[];
	let unresolvedExplicit: string[] = [];

	if (grant.tools !== undefined) {
		tools = [...grant.tools];
		unresolvedExplicit = tools.filter((name) => !available.has(name));
		if (grant.toolsInheritance === "parent") {
			diagnostics.push({
				level: "info",
				message: "tools_inheritance is ignored when tools is present",
			});
		}
	} else if (grant.toolsInheritance === "parent") {
		tools = [];
		for (const name of options.parentTools) {
			if (spawn.has(name)) continue;
			if (!available.has(name)) {
				diagnostics.push({
					level: "warning",
					message: `inherited tool "${name}" does not resolve in the child and was dropped`,
				});
				continue;
			}
			if (!tools.includes(name)) tools.push(name);
		}
	} else {
		tools = [];
	}

	return {
		tools,
		noTools: tools.length === 0 ? "all" : undefined,
		unresolvedExplicit,
		diagnostics,
	};
}
