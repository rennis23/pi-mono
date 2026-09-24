import { describe, expect, it } from "vitest";
import {
	aggregateResults,
	capText,
	createRedactor,
	DEFAULT_PER_RESULT_BYTES,
	DEFAULT_TOTAL_BYTES,
	formatResultText,
	redactSecrets,
} from "./output.js";
import { type RunResult, zeroUsage } from "./types.js";

function result(over: Partial<RunResult> = {}): RunResult {
	return {
		agent: "alpha",
		ok: true,
		partial: false,
		stopped: undefined,
		text: "hello",
		truncated: false,
		durationMs: 0,
		turns: 1,
		usage: zeroUsage(),
		stopReason: undefined,
		errorMessage: undefined,
		diagnostics: [],
		...over,
	};
}

describe("capText", () => {
	it("leaves text below the cap untouched", () => {
		expect(capText("short", 100)).toEqual({ text: "short", truncated: false });
	});

	it("leaves text exactly at the cap untouched", () => {
		const text = "a".repeat(10);
		expect(capText(text, 10)).toEqual({ text, truncated: false });
	});

	it("truncates with a correct omitted-byte marker", () => {
		const capped = capText("a".repeat(100), 10);
		expect(capped.truncated).toBe(true);
		expect(capped.text.startsWith("a".repeat(10))).toBe(true);
		expect(capped.text.endsWith("[output truncated: 90 bytes omitted]")).toBe(true);
	});

	it("never splits a multi-byte character", () => {
		const text = "\u00e9".repeat(100);
		const maxBytes = 51;
		const capped = capText(text, maxBytes);
		expect(capped.truncated).toBe(true);
		expect(capped.text.includes("\uFFFD")).toBe(false);
		const marker = capped.text.slice(capped.text.indexOf("\n\n"));
		const markerBytes = Buffer.byteLength(marker, "utf8");
		expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(maxBytes + markerBytes);
	});
});

describe("redactSecrets", () => {
	it("replaces occurrences of a secret", () => {
		expect(redactSecrets("key is sk-abcdefgh here", ["sk-abcdefgh"])).toBe("key is [redacted] here");
	});

	it("replaces every occurrence", () => {
		expect(redactSecrets("sk-abcdefgh and sk-abcdefgh", ["sk-abcdefgh"])).toBe("[redacted] and [redacted]");
	});

	it("ignores short and whitespace-only secrets", () => {
		expect(redactSecrets("keep abc and   ", ["abc", "   "])).toBe("keep abc and   ");
	});

	it("ignores undefined secrets", () => {
		expect(redactSecrets("abc", [undefined])).toBe("abc");
	});

	it("handles regex-special characters literally", () => {
		expect(redactSecrets("x a.b*cdef y", ["a.b*cdef"])).toBe("x [redacted] y");
	});

	it("redacts longest-first so overlaps leave no partial leak", () => {
		expect(redactSecrets("token abcd1234xyz end", ["abcd1234", "abcd1234xyz"])).toBe("token [redacted] end");
	});
});

describe("createRedactor", () => {
	it("collects credential-like env values and ignores unrelated ones", () => {
		const redact = createRedactor({
			OPENAI_API_KEY: "sk-abcdefgh",
			GITHUB_TOKEN: "gh-12345678",
			HOME: "/home/secretuser",
			DATABASE_URL: "postgres://user:pass@host/db",
		});
		const out = redact("sk-abcdefgh gh-12345678 /home/secretuser postgres://user:pass@host/db");
		expect(out).toBe("[redacted] [redacted] /home/secretuser postgres://user:pass@host/db");
	});

	it("includes extra secrets and ignores undefined env values", () => {
		const redact = createRedactor({ MISSING_SECRET: undefined }, ["supersecret123"]);
		expect(redact("val supersecret123")).toBe("val [redacted]");
	});

	it("returns a pure closure", () => {
		const redact = createRedactor({ API_KEY: "sk-abcdefgh" });
		expect(redact("sk-abcdefgh")).toBe("[redacted]");
		expect(redact("sk-abcdefgh")).toBe("[redacted]");
	});
});

describe("formatResultText", () => {
	it("renders a header line followed by the body", () => {
		expect(formatResultText(result({ text: "body" })).text).toBe("alpha: ok\nbody");
	});

	it("marks partial and failed results", () => {
		expect(formatResultText(result({ ok: false, partial: true })).text).toBe("alpha: partial\nhello");
		expect(formatResultText(result({ ok: false })).text).toBe("alpha: failed\nhello");
	});

	it("appends the error line when present", () => {
		expect(formatResultText(result({ ok: false, text: "oops", errorMessage: "boom" })).text).toBe(
			"alpha: failed\noops\nerror: boom",
		);
	});

	it("caps the formatted body", () => {
		const capped = formatResultText(result({ text: "x".repeat(1000) }), { perResultBytes: 20 });
		expect(capped.truncated).toBe(true);
		expect(capped.text).toContain("[output truncated:");
	});

	it("defaults to the documented per-result cap", () => {
		expect(DEFAULT_PER_RESULT_BYTES).toBe(32 * 1024);
		expect(DEFAULT_TOTAL_BYTES).toBe(128 * 1024);
	});
});

describe("aggregateResults", () => {
	it("joins formatted results with a separator", () => {
		const out = aggregateResults([result({ agent: "a1", text: "one" }), result({ agent: "a2", text: "two" })]);
		expect(out.text).toBe("a1: ok\none\n\n---\n\na2: ok\ntwo");
		expect(out.truncated).toBe(false);
	});

	it("reports truncation when the total cap is hit", () => {
		const out = aggregateResults([result({ text: "y".repeat(500) }), result({ text: "z".repeat(500) })], {
			totalBytes: 50,
		});
		expect(out.truncated).toBe(true);
		expect(out.text).toContain("[output truncated:");
	});

	it("reports truncation when a per-result cap is hit", () => {
		const out = aggregateResults([result({ text: "y".repeat(500) })], { perResultBytes: 20, totalBytes: 100_000 });
		expect(out.truncated).toBe(true);
	});

	it("returns an empty body for no results", () => {
		expect(aggregateResults([])).toEqual({ text: "", truncated: false });
	});
});
