/**
 * Strict, dependency-free YAML-subset frontmatter parser.
 *
 * This intentionally supports only the small slice of YAML that agent
 * definition files need — scalars and flat lists — and rejects everything else
 * with a line-numbered error. Rejecting loudly is the point: a definition that
 * silently misparses would change an agent's tools or model without anyone
 * noticing, so unknown syntax must be an error rather than a guess.
 *
 * The module is pure (no pi types, no I/O) so it is fully unit-testable.
 */

/** Successful parse: the decoded mapping and the trimmed markdown body. */
export interface FrontmatterOk {
	ok: true;
	data: Record<string, unknown>;
	body: string;
}

/** Failed parse: a single human-readable, line-numbered message. */
export interface FrontmatterError {
	ok: false;
	error: string;
}

export type FrontmatterParseResult = FrontmatterOk | FrontmatterError;

/** Internal scalar decode result, reused for values, list items and flow items. */
type ScalarResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Keys: start with a letter or underscore, then letters/digits/underscore/hyphen. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Characters a bare flow-list item may not contain (they signal nested YAML). */
const BARE_FORBIDDEN = /[[\]{}:,]/;

const NULL_WORDS = new Set(["null", "~", "Null", "NULL"]);

function err(error: string): { ok: false; error: string } {
	return { ok: false, error };
}

/** A first line / terminator is exactly `---` with only trailing spaces allowed. */
function isDashLine(line: string): boolean {
	return /^---[ ]*$/.test(line);
}

/** A block ends on a line that is exactly `---` or `...` (trailing spaces allowed). */
function isTerminatorLine(line: string): boolean {
	return /^(---|\.\.\.)[ ]*$/.test(line);
}

/**
 * Read a quoted string starting at `start` (which must be the opening quote).
 * Double quotes honor `\"` and `\\`; single quotes treat `''` as an escaped
 * quote. Returns the decoded text and the index just past the closing quote.
 */
function readQuoted(
	v: string,
	start: number,
	line: number,
	quote: '"' | "'",
): { ok: true; value: string; next: number } | { ok: false; error: string } {
	let i = start + 1;
	let out = "";
	while (i < v.length) {
		const c = v[i];
		if (quote === '"' && c === "\\") {
			const next = v[i + 1];
			if (next === '"' || next === "\\") {
				out += next;
				i += 2;
				continue;
			}
			out += c;
			i += 1;
			continue;
		}
		if (quote === "'" && c === "'" && v[i + 1] === "'") {
			out += "'";
			i += 2;
			continue;
		}
		if (c === quote) {
			return { ok: true, value: out, next: i + 1 };
		}
		out += c;
		i += 1;
	}
	const label = quote === '"' ? "double" : "single";
	return err(`unterminated ${label}-quoted string on line ${line}`);
}

/**
 * Decode a scalar: null words, booleans, safe integers, quoted strings, and
 * (as a fallback) a verbatim bare string. Numeric-looking non-integers are
 * rejected rather than coerced.
 */
function parseScalar(v: string, line: number): ScalarResult {
	if (v.startsWith('"')) {
		const q = readQuoted(v, 0, line, '"');
		if (!q.ok) return q;
		if (v.slice(q.next).trim() !== "") return err(`cannot parse line ${line}: ${v}`);
		return { ok: true, value: q.value };
	}
	if (v.startsWith("'")) {
		const q = readQuoted(v, 0, line, "'");
		if (!q.ok) return q;
		if (v.slice(q.next).trim() !== "") return err(`cannot parse line ${line}: ${v}`);
		return { ok: true, value: q.value };
	}
	if (NULL_WORDS.has(v)) return { ok: true, value: null };
	if (v === "true") return { ok: true, value: true };
	if (v === "false") return { ok: true, value: false };
	if (/^[+-]?[0-9]+$/.test(v)) {
		const n = Number(v);
		if (!Number.isSafeInteger(n)) return err(`unsafe integer value "${v}" on line ${line}`);
		return { ok: true, value: n };
	}
	// Decimals are allowed (cost budgets are fractional), but exponents and hex are not:
	// a value like `1e3` would silently change meaning depending on the reader.
	if (/^[+-]?(?:[0-9]+\.[0-9]+|\.[0-9]+)$/.test(v)) {
		const n = Number(v);
		if (!Number.isFinite(n)) return err(`unsupported numeric value "${v}" on line ${line}`);
		return { ok: true, value: n };
	}
	if (/^[+-]?(\.[0-9]|[0-9])/.test(v)) return err(`unsupported numeric value "${v}" on line ${line}`);
	return { ok: true, value: v };
}

/**
 * Parse a flow list `[a, b, c]`. Bare items may not contain `[]{}:,`; quoted
 * items may contain anything. Empty `[]` is allowed; trailing commas are not.
 */
function parseFlowList(v: string, line: number): ScalarResult {
	const items: unknown[] = [];
	let i = 1;
	let expectItem = true;
	let seenAny = false;
	while (i < v.length) {
		while (i < v.length && v[i] === " ") i += 1;
		if (i >= v.length) return err(`unterminated flow list on line ${line}`);
		const c = v[i];
		if (c === "]") {
			if (expectItem && seenAny) return err(`trailing comma in flow list on line ${line}`);
			i += 1;
			if (v.slice(i).trim() !== "") return err(`cannot parse line ${line}: ${v.trim()}`);
			return { ok: true, value: items };
		}
		if (c === "," || c === "[" || c === "{" || c === ":" || c === "}") {
			return err(`cannot parse line ${line}: ${v.trim()}`);
		}
		if (c === '"' || c === "'") {
			const q = readQuoted(v, i, line, c);
			if (!q.ok) return q;
			items.push(q.value);
			i = q.next;
		} else {
			let j = i;
			while (j < v.length && v[j] !== "," && v[j] !== "]") j += 1;
			const rawItem = v.slice(i, j).trim();
			if (rawItem === "" || BARE_FORBIDDEN.test(rawItem)) return err(`cannot parse line ${line}: ${v.trim()}`);
			const s = parseScalar(rawItem, line);
			if (!s.ok) return s;
			items.push(s.value);
			i = j;
		}
		seenAny = true;
		expectItem = false;
		while (i < v.length && v[i] === " ") i += 1;
		if (i >= v.length) return err(`unterminated flow list on line ${line}`);
		if (v[i] === ",") {
			i += 1;
			expectItem = true;
			continue;
		}
		if (v[i] === "]") continue;
		return err(`cannot parse line ${line}: ${v.trim()}`);
	}
	return err(`unterminated flow list on line ${line}`);
}

/**
 * Decode any right-hand-side value: reject anchors/aliases/tags and flow maps
 * first (they would silently change meaning), then dispatch on the first char.
 */
function parseValue(raw: string, line: number): ScalarResult {
	const v = raw.trim();
	if (v === "") return { ok: true, value: null };
	const c = v[0];
	if (c === "&" || c === "*" || c === "!") {
		return err(`anchors, aliases and tags are not supported (line ${line})`);
	}
	if (c === "{") return err(`flow mappings are not supported (line ${line})`);
	if (c === "[") return parseFlowList(v, line);
	return parseScalar(v, line);
}

/**
 * Parse a frontmatter-prefixed markdown document.
 *
 * Input is normalized (BOM stripped, CRLF → LF) before the first line is
 * required to be `---`. The block ends at `---`/`...`; the body is everything
 * after it, trimmed. Multi-document input (a body whose first non-blank line is
 * `---`) is rejected outright.
 */
export function parseFrontmatter(content: string): FrontmatterParseResult {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");

	if (lines.length === 0 || !isDashLine(lines[0])) {
		return { ok: false, error: 'missing frontmatter block (expected "---" on line 1)' };
	}

	let terminator = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (isTerminatorLine(lines[i])) {
			terminator = i;
			break;
		}
	}
	if (terminator === -1) {
		return { ok: false, error: "unterminated frontmatter block starting on line 1" };
	}

	const bodyLines = lines.slice(terminator + 1);
	for (const bodyLine of bodyLines) {
		if (bodyLine.trim() === "") continue;
		if (bodyLine.trim() === "---") {
			return { ok: false, error: "multi-document frontmatter is not supported" };
		}
		break;
	}
	const body = bodyLines.join("\n").trim();

	const data: Record<string, unknown> = {};
	let pendingKey: string | undefined;
	let pendingItems: unknown[] | undefined;

	// Flush a key whose value was empty: a list if items followed, else null.
	const commit = (): void => {
		if (pendingKey !== undefined) {
			data[pendingKey] = pendingItems === undefined ? null : pendingItems;
			pendingKey = undefined;
			pendingItems = undefined;
		}
	};

	for (let idx = 1; idx < terminator; idx += 1) {
		const raw = lines[idx];
		const lineNo = idx + 1;
		if (raw.trim() === "") continue;

		const indent = raw.match(/^[ \t]*/)?.[0] ?? "";
		if (indent.includes("\t")) {
			return { ok: false, error: `tab indentation is not supported (line ${lineNo})` };
		}
		if (raw.trimStart().startsWith("#")) continue;

		if (raw[0] === " ") {
			const trimmed = raw.trim();
			if (trimmed.startsWith("- ")) {
				if (pendingKey === undefined) {
					return { ok: false, error: `list item without a key on line ${lineNo}` };
				}
				const parsed = parseValue(trimmed.slice(2), lineNo);
				if (!parsed.ok) return { ok: false, error: parsed.error };
				if (pendingItems === undefined) pendingItems = [];
				pendingItems.push(parsed.value);
				continue;
			}
			if (pendingKey !== undefined) {
				return { ok: false, error: `nested mappings are not supported (line ${lineNo})` };
			}
			return { ok: false, error: `cannot parse line ${lineNo}: ${trimmed}` };
		}

		const colon = raw.indexOf(":");
		if (colon === -1) {
			return { ok: false, error: `cannot parse line ${lineNo}: ${raw.trim()}` };
		}
		const key = raw.slice(0, colon);
		if (!KEY_RE.test(key)) {
			return { ok: false, error: `cannot parse line ${lineNo}: ${raw.trim()}` };
		}
		if (key in data || key === pendingKey) {
			return { ok: false, error: `duplicate key "${key}" on line ${lineNo}` };
		}
		commit();

		const valueRaw = raw.slice(colon + 1).trim();
		if (valueRaw === "") {
			pendingKey = key;
			pendingItems = undefined;
			continue;
		}
		const parsed = parseValue(valueRaw, lineNo);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		data[key] = parsed.value;
	}

	commit();
	return { ok: true, data, body };
}
