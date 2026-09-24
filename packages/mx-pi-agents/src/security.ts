/**
 * Security helpers for the agent registry.
 *
 * Untrusted agent definitions can carry hostile names and paths. Every helper
 * here is total and fail-closed: it either produces a safe value (control-free
 * text, a slug, a hash) or it throws/returns `false` for a path that escapes
 * its root. Nothing in this module touches the network or mutates global state.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** C0 controls (minus tab/newline), DEL and C1 controls. Always removed. */
const ALWAYS_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Newlines are stripped unless explicitly kept. */
const NEWLINE = /\n/g;
/** Characters permitted in a `safeTempName` segment. */
const TEMP_NAME_SAFE = /[^A-Za-z0-9._-]/g;
/** Runs of dots, collapsed so `..` can never survive. */
const DOT_RUN = /\.{2,}/g;
/** Characters permitted in a slug produced by `sanitizeName`. */
const NAME_SAFE = /[^A-Za-z0-9._-]/g;
/** Runs of hyphens, collapsed after hostile chars are mapped to `-`. */
const HYPHEN_RUN = /-+/g;
const LEADING_TRAILING_HYPHEN = /^-+|-+$/g;
const LEADING_DOTS = /^\.+/;

/**
 * Remove C0 controls (U+0000–U+001F), DEL (U+007F) and C1 controls
 * (U+0080–U+009F). Tab is kept; newline is kept only when `keepNewlines`.
 */
export function stripControlChars(text: string, options?: { keepNewlines?: boolean }): string {
	const withoutControls = text.replace(ALWAYS_CONTROL, "");
	return options?.keepNewlines ? withoutControls : withoutControls.replace(NEWLINE, "");
}

/** Hard-cap `text` to `maxLength` characters, marking truncation with `…`. */
function truncate(text: string, maxLength: number): string {
	const limit = Math.max(0, Math.floor(maxLength));
	if (text.length <= limit) return text;
	if (limit === 0) return "";
	return `${text.slice(0, limit - 1)}…`;
}

/** Single-line, control-free UI label: collapse whitespace, trim, cap. */
export function sanitizeUiText(text: string, maxLength = 200): string {
	const collapsed = stripControlChars(text, { keepNewlines: false }).replace(/\s+/g, " ").trim();
	return truncate(collapsed, maxLength);
}

/**
 * Coerce an arbitrary string into a safe identifier: control-free, lowercased
 * `[a-z0-9._-]`, single hyphens, no leading/trailing hyphen. Empty → "agent".
 */
export function sanitizeName(raw: string, maxLength = 64): string {
	const slug = stripControlChars(raw, { keepNewlines: false })
		.replace(/\s+/g, " ")
		.trim()
		.replace(NAME_SAFE, "-")
		.replace(HYPHEN_RUN, "-")
		.replace(LEADING_TRAILING_HYPHEN, "")
		.toLowerCase();
	const limited = slug.slice(0, Math.max(0, Math.floor(maxLength)));
	return limited.length > 0 ? limited : "agent";
}

/** Hex SHA-256 of a utf8 string or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** First `length` characters of a hash, lowercased. No padding. */
export function shortHash(hash: string, length = 12): string {
	const limit = Math.max(0, Math.floor(length));
	return hash.slice(0, limit).toLowerCase();
}

/**
 * Collapse arbitrary text to a single path segment safe to join under a temp
 * dir: only `[A-Za-z0-9._-]`, no `..`, no separators, no leading dot.
 */
export function safeTempName(raw: string): string {
	const mapped = raw.replace(TEMP_NAME_SAFE, "_").replace(DOT_RUN, ".").replace(LEADING_DOTS, "").slice(0, 64);
	return mapped.length > 0 ? mapped : "agent";
}

/**
 * Absolute path with symlinks resolved for the nearest existing ancestor; the
 * still-missing trailing segments are re-appended verbatim. Lets containment
 * checks be deterministic even when the leaf does not exist yet.
 */
export function realPathOfNearestExisting(target: string): string {
	const absolute = resolve(target);
	const segments: string[] = [];
	let current = absolute;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		segments.unshift(basename(current));
		current = parent;
	}
	if (!existsSync(current)) return absolute;
	const base = realpathSync(current);
	return segments.length > 0 ? join(base, ...segments) : base;
}

/**
 * True iff `candidate` realpaths to `root` or lives beneath it. Fail-closed:
 * a nonexistent root, a sibling sharing a name prefix (`/tmp/xy` vs `/tmp/x`)
 * or a symlink escaping the root all return false.
 */
export function isPathContained(root: string, candidate: string): boolean {
	if (!existsSync(root)) return false;
	const realRoot = realPathOfNearestExisting(root);
	const realCandidate = realPathOfNearestExisting(candidate);
	return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

/** Throw when `candidate` escapes `root`, naming the offending `label`. */
export function assertPathContained(root: string, candidate: string, label: string): void {
	if (!isPathContained(root, candidate)) {
		throw new Error(`${label} escaped ${root}: ${candidate}`);
	}
}
