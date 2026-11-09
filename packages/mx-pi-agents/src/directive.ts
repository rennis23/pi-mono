/**
 * Parser for the `#` invocation directive used by the TUI input handler.
 *
 * Grammar (normative for this package):
 *
 *   directive := ws? "#" name _ws task
 *   task      := anything (trimmed); absent means no task
 *   name      := [A-Za-z0-9][A-Za-z0-9_-]{0,63}
 *
 * Delegation was removed in the persona-only extraction, so a bracketed
 * `#[…]` pipeline is reported as an error instead of being parsed.
 *
 * This module is pure and pi-free: it takes editor text and returns a
 * `Directive` or a ready-to-display error message. It never touches the
 * registry, a session or a model.
 */

/** A parsed directive: the agent name and the optional task text. */
export interface Directive {
	name: string;
	/** Task text; `undefined` means the directive had no task. */
	task: string | undefined;
}

export type DirectiveOutcome = { ok: true; directive: Directive } | { ok: false; message: string };

const USAGE = 'Usage: "#name [prompt]" or "#none"';

/**
 * Parse an editor input into a directive.
 *
 * Returns `undefined` when the text is not a directive at all (no leading `#`
 * after optional whitespace), so the caller can forward it to the model. When
 * the text *is* a directive but is malformed, returns `{ ok: false, message }`
 * with a user-facing explanation.
 */
export function parseDirective(text: string): DirectiveOutcome | undefined {
	const lead = text.match(/^[ \t]*#/);
	if (!lead) return undefined;
	const rest = text.slice(lead[0].length);
	if (rest.startsWith("[")) {
		return {
			ok: false,
			message: `bracketed pipelines were removed in mx-pi-agents. ${USAGE}`,
		};
	}
	return parseSingle(rest);
}

function parseSingle(rest: string): DirectiveOutcome {
	if (/^[ \t]*$/.test(rest)) {
		return { ok: false, message: `no agent named in directive. ${USAGE}` };
	}

	const nameMatch = rest.match(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}/);
	if (!nameMatch) {
		return { ok: false, message: `invalid agent name in directive. ${USAGE}` };
	}
	const name = nameMatch[0];
	const afterName = rest.slice(name.length);

	// A name may be at most 64 characters; a further name character means the
	// declared name is out of bounds, not that the task started.
	if (/^[A-Za-z0-9_-]/.test(afterName)) {
		return { ok: false, message: `invalid agent name in directive. ${USAGE}` };
	}

	// A pipeline delimiter next to a bare name is a removed-pipeline typo.
	if (/^[ \t]*[>,]/.test(afterName)) {
		return {
			ok: false,
			message: `pipelines were removed in mx-pi-agents. ${USAGE}`,
		};
	}

	// A single name may stand alone; a `replace`/`append` switch uses the task
	// as the first prompt under the new persona.
	const taskMatch = afterName.match(/^[ \t]+([\s\S]*)$/);
	const task = taskMatch ? taskMatch[1].trim() : "";
	return { ok: true, directive: { name, task: task.length > 0 ? task : undefined } };
}
