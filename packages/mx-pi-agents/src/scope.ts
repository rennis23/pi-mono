/**
 * Path scope: resolve the absolute directory roots a run may touch, and check a
 * candidate path against them.
 *
 * The scope model is the same shape as the grant contract: total and
 * non-additive. A missing declaration means the run's own cwd — never the host.
 * A definition may tighten the configured ceiling, never loosen it. A malformed
 * or unresolvable scope is a refusal, never "unrestricted".
 *
 * Containment reuses `isPathContained` (`src/security.ts`); there is no second
 * containment implementation. This module adds only the scope-specific rules:
 * the ancestor refusal, the ceiling comparison and the resolvability check.
 */

import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { resolveAgentPath } from "./config.js";
import { isPathContained, realPathOfNearestExisting } from "./security.js";
import type { IsolationMode, SandboxMode } from "./types.js";

/** The typed "unrestricted" root. Only an explicit `/` ceiling may reach it. */
export const UNRESTRICTED_ROOT = "/";

/** Why a scope could not be resolved. Both are members of `RefusalReason`. */
export type ScopeRefusalReason = "scope-invalid" | "scope-unenforceable";

/** Resolved scope, or the reason the run must be refused before it starts. */
export type ScopeOutcome =
	| { ok: true; roots: string[]; unrestricted: boolean }
	| { ok: false; reason: ScopeRefusalReason; message: string };

/** The execution shape whose confinability is being decided. */
export interface ScopeVector {
	isolation: IsolationMode;
	sandbox: SandboxMode;
	tools: readonly string[];
}

export interface ResolveScopeInput {
	/** Definition frontmatter `scope`. `undefined` means absent, `[]` means empty. */
	definitionScope?: readonly string[];
	/** Config ceiling. `undefined`/empty falls back to `[cwd]`. */
	ceiling?: readonly string[];
	/** The run's working directory (the parent's cwd). */
	cwd: string;
	/** When present, an unconfineable vector is refused unless licensed by a `/` ceiling. */
	vector?: ScopeVector;
}

/**
 * Per-tool path parameter. Absent or empty means the run's cwd. `mode` records
 * the read/write side for documentation; both sides are checked against the
 * same roots today so a scope can never be read-only "by accident".
 */
export const PATH_PARAM: Record<string, { field: string; mode: "read" | "write" | "both" }> = {
	read: { field: "path", mode: "read" },
	ls: { field: "path", mode: "read" },
	grep: { field: "path", mode: "read" },
	find: { field: "path", mode: "read" },
	write: { field: "path", mode: "write" },
	edit: { field: "path", mode: "write" },
};

/** Thrown when a tool argument escapes the run scope. Fails the tool closed. */
export class ScopeRefusalError extends Error {
	readonly reason = "scope-invalid" as const;

	constructor(message: string) {
		super(message);
		this.name = "ScopeRefusalError";
	}
}

function fail(reason: ScopeRefusalReason, message: string): ScopeOutcome {
	return { ok: false, reason, message };
}

/** True when no per-path hook can confine this run's file access. */
export function isUnconfineable(vector: ScopeVector): boolean {
	if (vector.isolation === "subprocess") return true;
	return vector.sandbox === "none" && vector.tools.includes("bash");
}

/** True when a ceiling root resolves to the filesystem root. */
export function isUnrestrictedCeiling(ceiling: readonly string[] | undefined): boolean {
	if (ceiling === undefined) return false;
	return ceiling.some((root) => realPathOfNearestExisting(root) === UNRESTRICTED_ROOT);
}

/** Resolve a declaration entry (`~`, absolute, or cwd-relative) to absolute. */
function resolveEntry(entry: string, cwd: string): string {
	return resolveAgentPath(entry, cwd);
}

/**
 * True when `candidate` is `of` itself or an ancestor of it. Used only for the
 * "scope entry at or above cwd" refusal.
 */
function isAncestorOrSelf(candidate: string, of: string): boolean {
	const realCandidate = realPathOfNearestExisting(candidate);
	const realOf = realPathOfNearestExisting(of);
	if (realCandidate === UNRESTRICTED_ROOT) return true;
	return realOf === realCandidate || realOf.startsWith(realCandidate + sep);
}

function unenforceableMessage(): string {
	return (
		"cannot be confined to a narrow path scope, and the configured ceiling does not license an unconfined run; " +
		'use sandbox: os (or isolation: process) or declare scope: ["/"] to run unconfined'
	);
}

/**
 * Resolve the effective scope for one run.
 *
 * Order: resolve the declared scope (a malformed declaration refuses on its own,
 * regardless of the vector), then handle an unconfineable vector. An explicit
 * definition `scope` always narrows, so an unconfineable vector combined with
 * one is refused even under a `/` ceiling.
 */
export function resolveScope(input: ResolveScopeInput): ScopeOutcome {
	const cwd = resolve(input.cwd);
	const ceilingDeclared = input.ceiling !== undefined && input.ceiling.length > 0;
	const ceiling = ceilingDeclared
		? (input.ceiling as readonly string[]).map((entry) => resolveEntry(entry, cwd))
		: [cwd];

	let roots: string[];
	const declared = input.definitionScope;

	if (declared === undefined) {
		// The default root is the run's own cwd, in canonical form so the
		// sandbox profile and the containment checks agree on symlinked parents
		// (`/tmp` → `/private/tmp`).
		roots = [realPathOfNearestExisting(cwd)];
		if (!ceiling.some((root) => isPathContained(root, cwd))) {
			return fail("scope-invalid", `the run cwd ${cwd} is outside the configured scope ceiling`);
		}
	} else if (declared.length === 0) {
		return fail(
			"scope-invalid",
			'agent scope is empty; an empty scope is never "unrestricted" (omit the field for the cwd default)',
		);
	} else {
		const seen = new Set<string>();
		roots = [];
		for (const entry of declared) {
			const resolved = resolveEntry(entry, cwd);
			if (resolved.length === 0 || resolved === cwd) {
				return fail(
					"scope-invalid",
					`agent scope entry must be a subdirectory of the run cwd, not cwd itself: ${entry}`,
				);
			}
			if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
				return fail("scope-invalid", `agent scope root is not an existing directory: ${resolved}`);
			}
			const real = realPathOfNearestExisting(resolved);
			if (isAncestorOrSelf(real, cwd)) {
				return fail(
					"scope-invalid",
					`agent scope root is cwd or an ancestor of cwd (looser than the run directory): ${real}`,
				);
			}
			if (!ceiling.some((root) => isPathContained(root, real))) {
				return fail("scope-invalid", `agent scope root is outside the configured scope ceiling: ${real}`);
			}
			if (!seen.has(real)) {
				seen.add(real);
				roots.push(real);
			}
		}
	}

	if (input.vector !== undefined && isUnconfineable(input.vector)) {
		if (declared !== undefined) {
			// The definition asked for a narrower scope than the host; no hook can
			// enforce it for this vector, so the run does not run.
			return fail("scope-unenforceable", unenforceableMessage());
		}
		if (isUnrestrictedCeiling(ceiling)) {
			return { ok: true, roots: [UNRESTRICTED_ROOT], unrestricted: true };
		}
		return fail("scope-unenforceable", unenforceableMessage());
	}

	return { ok: true, roots, unrestricted: false };
}

/**
 * True iff `candidate` is inside at least one root. Fail-closed: a nonexistent
 * root, a sibling sharing a name prefix, or a symlink escape all return false.
 */
export function isPathInScope(roots: readonly string[], candidate: string): boolean {
	return roots.some((root) => isPathContained(root, candidate));
}

/** Throw a `ScopeRefusalError` when `candidate` escapes every root. */
export function assertPathInScope(roots: readonly string[], candidate: string, label: string): void {
	if (!isPathInScope(roots, candidate)) {
		throw new ScopeRefusalError(`${label} is outside the run scope (${describeScope(roots, false)}): ${candidate}`);
	}
}

/** Compact human description used in status lines and refusal messages. */
export function describeScope(roots: readonly string[], unrestricted: boolean, cwd?: string): string {
	if (unrestricted) return "host";
	if (roots.length === 1) {
		if (cwd !== undefined && realPathOfNearestExisting(roots[0]) === realPathOfNearestExisting(cwd)) return "cwd";
		return roots[0];
	}
	return `${roots.length} roots`;
}
