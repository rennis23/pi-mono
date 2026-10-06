/**
 * Autocomplete context and filtering for `#` directives.
 *
 * This module is pure and pi-free. `CompletionItem` is structurally compatible
 * with pi-tui's `AutocompleteItem`, mirroring how `render.ts` defines the
 * minimal `RenderTheme` surface. Nothing here reads the registry or the TUI.
 */

import { sanitizeUiText } from "./security.js";
import type { PinnedAgent, SystemPromptMode } from "./types.js";

/** One autocomplete row. Structurally an `AutocompleteItem`. */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/** A roster entry reduced to the fields autocomplete needs. */
export interface CompletionSource {
	name: string;
	description: string;
	source: string;
	trusted: boolean;
	mode: SystemPromptMode;
}

/** Where in a directive the cursor sits, and the text the popup filters on. */
export interface DirectiveContext {
	prefix: string;
}

const MAX_ITEMS = 20;

/** Project the pinned roster into the minimal autocomplete shape. */
export function toCompletionSource(agents: readonly PinnedAgent[]): CompletionSource[] {
	return agents.map((agent) => ({
		name: agent.definition.name,
		description: agent.definition.description,
		source: agent.source.kind,
		trusted: agent.source.trusted,
		mode: agent.definition.systemPrompt,
	}));
}

/**
 * Determine whether the cursor is in a completable directive position.
 *
 * Returns `undefined` outside a directive (mid-line `#`, an `@` line, a plain
 * prompt), once the trailing task has begun, or once a bracketed pipeline is
 * typed (pipelines were removed).
 */
export function directiveContext(textBeforeCursor: string): DirectiveContext | undefined {
	const lead = textBeforeCursor.match(/^[ \t]*#/);
	if (!lead) return undefined;
	const afterHash = textBeforeCursor.slice(lead[0].length);

	if (afterHash.startsWith("[")) return undefined;
	if (!/^[A-Za-z0-9_-]*$/.test(afterHash)) return undefined;
	return { prefix: `#${afterHash}` };
}

/**
 * Filter the roster for a directive context: prefix matches first, then
 * substring matches, capped at 20. An empty result is returned as `[]` (never
 * a file-completion fallback), so an unknown name shows an empty popup.
 *
 * The built-in `pi.dev [base]` row (`none`) resets the main session to plain
 * pi.
 */
export function completionItems(source: readonly CompletionSource[], context: DirectiveContext): CompletionItem[] {
	const term = context.prefix.replace(/^#/, "").toLowerCase();
	const prefixMatches: CompletionSource[] = [];
	const substringMatches: CompletionSource[] = [];

	for (const agent of source) {
		const name = agent.name.toLowerCase();
		if (term.length === 0 || name.startsWith(term)) prefixMatches.push(agent);
		else if (name.includes(term)) substringMatches.push(agent);
	}

	const rows = [...prefixMatches, ...substringMatches].slice(0, MAX_ITEMS).map((agent) => {
		const trust = agent.trusted ? "" : " gated";
		const label = sanitizeUiText(agent.name, 64);
		const description = sanitizeUiText(`${agent.description} · ${agent.source}${trust}`, 160);
		return {
			value: `#${agent.name}`,
			label: `${label} [${agent.mode}]`,
			description,
		};
	});

	if (term.length === 0 || "none".startsWith(term) || "pi.dev".startsWith(term)) {
		rows.unshift({ value: "#none", label: "pi.dev [base]", description: "reset to plain pi" });
	}

	return rows.slice(0, MAX_ITEMS);
}
