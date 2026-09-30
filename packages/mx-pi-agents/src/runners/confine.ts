/**
 * Path confinement for the file tools the extension supplies.
 *
 * pi's built-in file tools perform no path-containment check, and the operations
 * hook does not see it either: `GrepOperations`/`FindOperations` only expose the
 * operations, not the model-supplied search root. The one hook that sees every
 * raw argument is `ToolDefinition.execute`, so each granted file tool is built
 * with pi's own factory and its `execute` is replaced with a validator that
 * refuses an out-of-scope path before delegating. A tool that cannot be
 * recognized is refused, never passed through.
 *
 * This module is the only place pi's tool factories are called for a child, and
 * the wrapper set is derived from `plan.tools` so a granted file tool cannot be
 * left unwrapped.
 */

import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertPathInScope, PATH_PARAM, ScopeRefusalError } from "../scope.js";
import type { RunPlan } from "../types.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

/** The bundled file tools, each built by pi's own factory (pi-parity behaviour). */
const FILE_TOOL_FACTORIES: Record<string, (cwd: string) => AnyToolDefinition> = {
	read: (cwd) => createReadToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
};

/** True when this module knows how to confine the named tool. */
export function isConfinedToolName(name: string): boolean {
	return name in FILE_TOOL_FACTORIES;
}

/**
 * Wrap one tool definition so its path argument is contained in `roots`.
 *
 * The path field is resolved against `cwd` when absent or empty, so "no path"
 * means the run's own directory — never "unbounded". A non-string or
 * unrecognizable parameter shape throws a `ScopeRefusalError`, which fails the
 * tool call closed.
 */
export function confineToolDefinition(
	definition: AnyToolDefinition,
	options: { cwd: string; roots: readonly string[]; mode: "read" | "write" | "both" },
): AnyToolDefinition {
	const spec = PATH_PARAM[definition.name];
	if (spec === undefined) {
		throw new Error(`no path parameter registered for tool "${definition.name}"`);
	}

	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params === null || typeof params !== "object" || Array.isArray(params)) {
				throw new ScopeRefusalError(`${definition.name}: parameters are not an object`);
			}
			const raw = (params as Record<string, unknown>)[spec.field];
			if (raw !== undefined && raw !== null && typeof raw !== "string") {
				throw new ScopeRefusalError(`${definition.name}: ${spec.field} must be a string`);
			}
			const candidate = typeof raw === "string" && raw.trim().length > 0 ? raw : options.cwd;
			assertPathInScope(options.roots, candidate, `${definition.name}.${spec.field}`);
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/**
 * Build the confined definitions for every granted file tool.
 *
 * Returns `[]` for an unrestricted run: the effective scope is the host, so
 * there is no check to make. `bash` is deliberately absent — it is handled by
 * the sandbox wrapper (or refused upstream by the scope policy).
 */
export function buildGrantedTools(plan: RunPlan): AnyToolDefinition[] {
	if (plan.scope.unrestricted) return [];
	const out: AnyToolDefinition[] = [];
	for (const name of plan.tools) {
		const factory = FILE_TOOL_FACTORIES[name];
		if (factory === undefined) continue;
		out.push(
			confineToolDefinition(factory(plan.cwd), {
				cwd: plan.cwd,
				roots: plan.scope.roots,
				mode: PATH_PARAM[name].mode,
			}),
		);
	}
	return out;
}
