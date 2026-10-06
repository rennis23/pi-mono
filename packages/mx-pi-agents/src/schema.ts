/**
 * Agent definition schema.
 *
 * The schema is intentionally small and total: every field is validated, an
 * unknown field drops the definition, and errors carry a readable reason. The
 * `system_prompt` mode is parsed fail-closed: absent means `append`, and any
 * value that is not exactly `replace` or `append` drops the definition rather
 * than falling back to a permissive default.
 */

import { parseFrontmatter } from "./frontmatter.js";
import { sanitizeUiText } from "./security.js";
import type { AgentDefinition, SystemPromptMode, ThinkingLevel } from "./types.js";

/** Name charset: lowercase slug, starts alphanumeric, max 64 chars. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Tool names come from pi (`read`, `mcp__srv__tool`, …). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Model labels are `provider/model-id` or a bare model id. */
const MODEL_PATTERN = /^[A-Za-z0-9._/:-]{1,200}$/;
/**
 * Skill names follow pi's Agent Skills spec: lowercase a-z, digits and single
 * hyphens, no leading/trailing hyphen and no consecutive hyphens.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;
const MAX_SKILL_NAME_CHARS = 64;
/** Path entries: non-empty, no control characters, bounded length. */
const PATH_ENTRY_PATTERN = /^[^\u0000-\u001F\u007F]{1,1024}$/;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SYSTEM_PROMPT_MODES: readonly SystemPromptMode[] = ["replace", "append"];
/** The reset name always wins; a definition may never claim it. */
export const RESERVED_AGENT_NAME = "none";

export const MAX_DESCRIPTION_CHARS = 512;

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

/** Read a string-list field of tool names, deduping while preserving order. */
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

/** Read a string-list field holding skill names, deduping in order. */
function readSkillList(data: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
	const value = data[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${key} must be a list of skill names`);
		return undefined;
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			errors.push(`${key} contains an invalid skill name`);
			return undefined;
		}
		const name = item.trim();
		if (name.length > MAX_SKILL_NAME_CHARS || !SKILL_NAME_PATTERN.test(name)) {
			errors.push(`${key} contains an invalid skill name`);
			return undefined;
		}
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

/** Read a string-list field holding filesystem paths, deduping in order. */
function readPathList(data: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
	const value = data[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${key} must be a list of paths`);
		return undefined;
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			errors.push(`${key} contains an invalid path entry`);
			return undefined;
		}
		const entry = item.trim();
		if (!PATH_ENTRY_PATTERN.test(entry)) {
			errors.push(`${key} contains an invalid path entry`);
			return undefined;
		}
		if (!out.includes(entry)) out.push(entry);
	}
	return out;
}

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"system_prompt",
	"tools",
	"skills",
	"context_files",
	"model",
	"thinking",
]);

/**
 * Validate a frontmatter map into an `AgentDefinition`.
 *
 * Fails (drops the definition) on: missing/invalid name or description, unknown
 * fields, wrong value types, an out-of-range `thinking` value, an invalid
 * `system_prompt` value, and empty bodies. It never defaults a capability:
 * `tools`/`skills`/`context_files` stay `undefined` when absent so the switch
 * can distinguish "absent" from "empty".
 */
export function definitionFromRaw(data: Record<string, unknown>): DefinitionParseResult {
	const errors: string[] = [];

	for (const key of Object.keys(data)) {
		if (!KNOWN_FIELDS.has(key)) errors.push(`unknown field "${sanitizeUiText(key, 40)}"`);
	}
	if (errors.length > 0) return parseFailure(`invalid agent definition: ${errors.join("; ")}`);

	const rawName = readString(data, "name", errors);
	if (rawName === undefined) errors.push("name is required");
	else if (rawName === RESERVED_AGENT_NAME) {
		errors.push(`name "${RESERVED_AGENT_NAME}" is reserved for the built-in reset`);
	} else if (!NAME_PATTERN.test(rawName)) {
		errors.push('name must match [a-z0-9][a-z0-9_-]{0,63} (lowercase letters, digits, "-", "_")');
	}

	const rawDescription = readString(data, "description", errors);
	if (rawDescription === undefined || rawDescription.length === 0) errors.push("description is required");
	else if (rawDescription.length > MAX_DESCRIPTION_CHARS) {
		errors.push(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
	}

	const tools = readToolList(data, "tools", errors);
	const skills = readSkillList(data, "skills", errors);
	const contextFiles = readPathList(data, "context_files", errors);

	// Mode parsing is total and fail-closed: absent means `append`; a value that
	// is not exactly one of the two strings (or is not a string) fails the whole
	// definition rather than falling back to a permissive default.
	let systemPrompt: SystemPromptMode = "append";
	if (data.system_prompt !== undefined && data.system_prompt !== null) {
		if (
			typeof data.system_prompt === "string" &&
			(SYSTEM_PROMPT_MODES as readonly string[]).includes(data.system_prompt)
		) {
			systemPrompt = data.system_prompt as SystemPromptMode;
		} else {
			errors.push(`system_prompt must be one of: ${SYSTEM_PROMPT_MODES.join(", ")}`);
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

	if (errors.length > 0) return parseFailure(`invalid agent definition: ${errors.join("; ")}`);

	return {
		ok: true,
		definition: {
			name: rawName!,
			description: rawDescription!,
			systemPrompt,
			tools,
			skills,
			contextFiles,
			model,
			thinking,
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
