/**
 * Security helpers for the agent registry.
 *
 * Untrusted agent definitions can carry hostile names and paths. Every helper
 * here is total: it either produces a safe value (control-free text, a hash) or
 * it throws. Nothing in this module touches the network or mutates global state.
 */

import { createHash } from "node:crypto";

/** C0 controls (minus tab/newline), DEL and C1 controls. Always removed. */
const ALWAYS_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Newlines are stripped unless explicitly kept. */
const NEWLINE = /\n/g;

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

/** Hex SHA-256 of a utf8 string or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}
