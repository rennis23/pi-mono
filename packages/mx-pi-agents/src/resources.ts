/**
 * Main-session resource allow-lists.
 *
 * A `persona`/`main` definition may narrow what pi's resource loader puts into
 * the system prompt while its switch is active: which skills and which project
 * context files survive. The semantics mirror the tool grants:
 *
 * - absent (`undefined`) → inherit the loaded set
 * - `[]` → none
 * - `[a, b]` → only the named entries
 *
 * pi loads resources at session start and has no unload call, so a definition
 * can only narrow what the session already has — an unknown entry matches
 * nothing and can never widen the set.
 *
 * This module is pure and pi-free: callers pass the loaded resources plus the
 * session cwd, and get new arrays back.
 */

/** Minimal shape of a loaded skill: `name` is the filter key. */
export interface SkillLike {
	name: string;
}

/** Minimal shape of a loaded project context file: `path` is the filter key. */
export interface ContextFileLike {
	path: string;
}

/** Normalize a path for matching: forward slashes, no trailing slash. */
function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Whether a skill survives an allow-list. `undefined` means the definition did
 * not declare the field, so every loaded skill survives.
 */
export function skillAllowed(name: string, allow: readonly string[] | undefined): boolean {
	return allow === undefined || allow.includes(name);
}

/**
 * Whether a context file survives an allow-list. An entry matches the absolute
 * path, the path relative to `cwd`, or the basename, so `AGENTS.md` matches
 * both the global and the project copy.
 */
export function contextFileAllowed(path: string, allow: readonly string[] | undefined, cwd: string): boolean {
	if (allow === undefined) return true;
	const full = normalizePath(path);
	const base = full.slice(full.lastIndexOf("/") + 1);
	const root = normalizePath(cwd);
	const relative = root.length > 0 && full.startsWith(`${root}/`) ? full.slice(root.length + 1) : undefined;
	return allow.some((entry) => {
		const candidate = normalizePath(entry.trim());
		return candidate === full || candidate === base || (relative !== undefined && candidate === relative);
	});
}

/** Filter loaded skills, preserving order. Always returns a new array. */
export function filterSkills<T extends SkillLike>(skills: readonly T[], allow: readonly string[] | undefined): T[] {
	return skills.filter((skill) => skillAllowed(skill.name, allow));
}

/** Filter loaded project context files, preserving order. Always returns a new array. */
export function filterContextFiles<T extends ContextFileLike>(
	files: readonly T[],
	allow: readonly string[] | undefined,
	cwd: string,
): T[] {
	return files.filter((file) => contextFileAllowed(file.path, allow, cwd));
}
