/**
 * Path normalization for the tool arguments the extension confines.
 *
 * pi expands `~` and strips a leading `@` before it opens a path, so a check on
 * the raw argument can be bypassed: `~/.ssh/id_rsa` looks cwd-relative to a naive
 * check but resolves to the real home file. The scope check must therefore run on
 * the form pi actually opens — the normalized path, plus the macOS name variants
 * a case-insensitive/HFS-normalizing filesystem may resolve it to.
 *
 * This module owns only the normalization; containment itself stays in
 * `isPathContained` (`src/security.ts`) via `assertPathInScope` (`src/scope.ts`).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/** Unicode spaces that pi collapses to an ASCII space before resolving a path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Same normalization pi applies before it opens a path. */
export function normalizeToolPath(raw: string, home: string = homedir()): string {
	let value = raw.replace(UNICODE_SPACES, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") return home;
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return value;
}

/** Paths pi may open for this input: the base path plus macOS name variants. */
export function candidatePaths(normalized: string, cwd: string): string[] {
	const base = resolve(cwd, normalized);
	const variants = [
		base.replace(/ (AM|PM)\./gi, "\u202F$1."),
		base.normalize("NFD"),
		base.replace(/'/g, "\u2019"),
		base.normalize("NFD").replace(/'/g, "\u2019"),
	];
	return [base, ...variants.filter((v, i, all) => v !== base && all.indexOf(v) === i)];
}

/** True when the raw form starts with `~` followed by a user name (not supported). */
export function isUnsupportedTilde(raw: string): boolean {
	const value = raw.replace(/^@/, "");
	return /^~[^/]/.test(value);
}
