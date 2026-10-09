/**
 * Tool selection rule.
 *
 * Mirrors pi's `defaultTools` entry semantics so a definition can change the
 * session's tool selection instead of replacing it: plain names form the
 * selection, then `+name` adds and `-name` removes, in list order. A list of
 * only modifiers changes the inherited selection rather than replacing it.
 *
 * This module owns only the rule. Validation lives in `schema.ts`, the
 * fail-closed resolution in `persona.ts`, and the application in `index.ts`.
 */

import type { ToolEntry, ToolEntryOp } from "./types.js";

/** Tool name as pi reports it (`read`, `mcp__srv__tool`, …). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Parse one raw frontmatter entry. A bare `+`/`-` or a malformed name returns `undefined`. */
export function parseToolEntry(raw: string): ToolEntry | undefined {
	const entry = raw.trim();
	let op: ToolEntryOp = "plain";
	let name = entry;
	if (entry.startsWith("+")) {
		op = "add";
		name = entry.slice(1);
	} else if (entry.startsWith("-")) {
		op = "remove";
		name = entry.slice(1);
	}
	if (name.length === 0 || !TOOL_NAME_PATTERN.test(name)) return undefined;
	return { op, name };
}

/** Canonical text of an entry, exactly as declared. */
export function formatToolEntry(entry: ToolEntry): string {
	if (entry.op === "plain") return entry.name;
	return `${entry.op === "add" ? "+" : "-"}${entry.name}`;
}

/**
 * Resolve declared entries against the inherited selection.
 *
 * Plain names form the selection; modifiers then apply in order. Adding a name
 * already present and removing a name that is not present are no-ops, so a
 * definition that asks for something the session already has changes nothing.
 * Names are deduplicated, as in pi.
 */
export function resolveToolSelection(entries: readonly ToolEntry[], inherited: readonly string[]): string[] {
	const tools: string[] = [];
	for (const entry of entries) {
		if (entry.op === "plain" && !tools.includes(entry.name)) tools.push(entry.name);
	}
	// A list of only modifiers changes the inherited selection rather than replacing it.
	if (tools.length === 0 && entries.length > 0) {
		for (const name of inherited) {
			if (!tools.includes(name)) tools.push(name);
		}
	}
	for (const entry of entries) {
		if (entry.op === "plain") continue;
		const index = tools.indexOf(entry.name);
		if (entry.op === "add") {
			if (index === -1) tools.push(entry.name);
		} else if (index !== -1) {
			tools.splice(index, 1);
		}
	}
	return tools;
}
