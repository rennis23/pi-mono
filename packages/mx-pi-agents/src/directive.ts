/**
 * Parser for the `#` invocation directive used by the TUI input handler.
 *
 * Grammar (normative, see the plan):
 *
 *   directive := ws? "#" name          _ws task
 *              | ws? "#" "[" pipeline "]" _ws task
 *   pipeline  := stage ( ws? ">" ws? stage )*
 *   stage     := name  ( ws? "," ws? name  )*
 *   name      := [A-Za-z0-9][A-Za-z0-9_-]{0,63}
 *
 * This module is pure and pi-free: it takes editor text and returns a
 * `Directive` or a ready-to-display error message. It never touches the
 * registry, a session or a model.
 */

/** Hard cap on how many stages one directive may declare. */
export const MAX_PIPELINE_STAGES = 16;

/** One pipeline stage. More than one agent means a parallel group. */
export interface DirectiveStage {
	agents: string[];
}

/** A parsed directive: the stages to run and the stage-1 task. */
export interface Directive {
	stages: DirectiveStage[];
	/** Stage-1 task; `undefined` means the directive had no task text. */
	task: string | undefined;
	/** True for a bracketed `#[…]` pipeline; false for a bare `#name`. */
	pipeline: boolean;
}

export type DirectiveOutcome = { ok: true; directive: Directive } | { ok: false; message: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const USAGE = 'Usage: "#agent [prompt]" or "#[a > b, c] <prompt>"';

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
	if (rest.startsWith("[")) return parsePipeline(rest.slice(1));
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

	// D10: a pipeline delimiter next to a bare name is a bracketed-pipeline typo.
	if (/^[ \t]*[>,]/.test(afterName)) {
		return {
			ok: false,
			message: `pipelines require brackets: "#[${name} > other]". ${USAGE}`,
		};
	}

	// A single name may stand alone: the kind decides whether it switches the
	// main session (persona/main) or delegates (sub). Only pipelines require a
	// task text.
	const taskMatch = afterName.match(/^[ \t]+([\s\S]*)$/);
	const task = taskMatch ? taskMatch[1].trim() : "";
	return {
		ok: true,
		directive: { stages: [{ agents: [name] }], task: task.length > 0 ? task : undefined, pipeline: false },
	};
}

function parsePipeline(body: string): DirectiveOutcome {
	const close = body.indexOf("]");
	if (close === -1) {
		return { ok: false, message: `unclosed pipeline: missing "]". ${USAGE}` };
	}

	const pipelineText = body.slice(0, close);
	const taskText = body.slice(close + 1);
	if (pipelineText.trim().length === 0) {
		return { ok: false, message: `empty pipeline. ${USAGE}` };
	}

	const rawStages = pipelineText.split(">");
	if (rawStages.length > MAX_PIPELINE_STAGES) {
		return {
			ok: false,
			message: `too many stages (${rawStages.length}). Max is ${MAX_PIPELINE_STAGES}.`,
		};
	}

	const taskMatch = taskText.match(/^[ \t]+([\s\S]*)$/);
	const task = taskMatch ? taskMatch[1].trim() : "";
	if (task.length === 0) {
		return { ok: false, message: `pipeline directive is missing a prompt. ${USAGE}` };
	}

	const stages: DirectiveStage[] = [];
	for (const rawStage of rawStages) {
		const rawNames = rawStage.split(",");
		const agents: string[] = [];
		for (const rawName of rawNames) {
			const name = rawName.trim();
			if (name.length === 0) {
				return { ok: false, message: `empty stage or dangling delimiter in pipeline. ${USAGE}` };
			}
			if (!NAME_RE.test(name)) {
				return { ok: false, message: `invalid agent name "${name}" in pipeline. ${USAGE}` };
			}
			agents.push(name);
		}
		stages.push({ agents });
	}

	return { ok: true, directive: { stages, task, pipeline: true } };
}
