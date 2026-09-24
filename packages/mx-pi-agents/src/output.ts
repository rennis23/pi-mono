/**
 * Result-text capping and secret redaction.
 *
 * Output from a child run can be arbitrarily large and can echo environment
 * secrets, so every result that leaves the runner passes through here: first
 * redaction, then a UTF-8-aware byte cap per result and across the aggregate.
 * All functions are pure.
 */

import type { RunResult } from "./types.js";

/** Per-result byte cap applied before results are joined. */
export const DEFAULT_PER_RESULT_BYTES: number = 32 * 1024;
/** Total byte cap applied to the joined aggregate. */
export const DEFAULT_TOTAL_BYTES: number = 128 * 1024;

/** A possibly-truncated text body. */
export interface CappedText {
	text: string;
	truncated: boolean;
}

/** Byte-cap overrides for result formatting. */
export interface CapOptions {
	perResultBytes?: number;
	totalBytes?: number;
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character. The first excluded byte is walked back over any UTF-8 continuation
 * bytes (0b10xxxxxx) so the retained slice always ends on a character boundary.
 */
function utf8Slice(text: string, maxBytes: number): { kept: string; keptBytes: number; totalBytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return { kept: text, keptBytes: buf.length, totalBytes: buf.length };
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return { kept: buf.subarray(0, end).toString("utf8"), keptBytes: end, totalBytes: buf.length };
}

/**
 * Cap `text` to `maxBytes` UTF-8 bytes, appending a marker naming the omitted
 * byte count when it is cut. Returns the original text untouched when it fits.
 */
export function capText(text: string, maxBytes: number): CappedText {
	const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
	const { kept, keptBytes, totalBytes } = utf8Slice(text, cap);
	if (totalBytes <= cap) return { text, truncated: false };
	const omitted = totalBytes - keptBytes;
	return { text: `${kept}\n\n[output truncated: ${omitted} bytes omitted]`, truncated: true };
}

/** A secret worth redacting: a real string of at least 8 non-whitespace chars. */
function isSecret(value: string | undefined): value is string {
	return typeof value === "string" && value.length >= 8 && value.trim().length > 0;
}

/** Deduped secrets, longest first so overlapping values leave no partial leak. */
function orderedSecrets(secrets: Array<string | undefined>): string[] {
	return [...new Set(secrets.filter(isSecret))].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each usable secret with `[redacted]`. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
	let out = text;
	for (const secret of orderedSecrets(secrets)) {
		out = out.split(secret).join("[redacted]");
	}
	return out;
}

/** Env keys that conventionally hold credentials. */
const SECRET_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/**
 * Build a pure redactor from an environment snapshot plus explicit secrets.
 * Only values under credential-looking keys are collected, so unrelated env
 * vars never blank out legitimate result text.
 */
export function createRedactor(
	env: Record<string, string | undefined>,
	extraSecrets: string[] = [],
): (text: string) => string {
	const collected: Array<string | undefined> = [];
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY.test(key)) collected.push(value);
	}
	collected.push(...extraSecrets);
	const secrets = orderedSecrets(collected);
	return (text: string) => redactSecrets(text, secrets);
}

/** Header status word for a result: ok, partial, or failed. */
function statusWord(result: RunResult): "ok" | "partial" | "failed" {
	if (result.ok) return "ok";
	if (result.partial) return "partial";
	return "failed";
}

/**
 * Render one result as `<agent>: <status>`, its text, and an optional error
 * line, then cap the body to `perResultBytes`.
 */
export function formatResultText(result: RunResult, options?: CapOptions): CappedText {
	const perResultBytes = options?.perResultBytes ?? DEFAULT_PER_RESULT_BYTES;
	const lines = [`${result.agent}: ${statusWord(result)}`, result.text];
	if (result.errorMessage) lines.push(`error: ${result.errorMessage}`);
	return capText(lines.join("\n"), perResultBytes);
}

/**
 * Format every result (each capped) and join them, then apply the total cap.
 * `truncated` is true when either stage truncated.
 */
export function aggregateResults(results: RunResult[], options?: CapOptions): CappedText {
	const perResultBytes = options?.perResultBytes ?? DEFAULT_PER_RESULT_BYTES;
	const totalBytes = options?.totalBytes ?? DEFAULT_TOTAL_BYTES;
	const formatted = results.map((result) => formatResultText(result, { perResultBytes }));
	const anyPerResult = formatted.some((entry) => entry.truncated);
	const capped = capText(formatted.map((entry) => entry.text).join("\n\n---\n\n"), totalBytes);
	return { text: capped.text, truncated: anyPerResult || capped.truncated };
}
