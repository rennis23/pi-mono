import { describe, expect, it } from "vitest";
import { sanitizeUiText, sha256Hex, stripControlChars } from "./security.js";

describe("stripControlChars", () => {
	it("keeps tab and strips every other control", () => {
		expect(stripControlChars("a\tb")).toBe("a\tb");
		expect(stripControlChars("a\u0000b\u007fc\u0085d")).toBe("abcd");
	});

	it("strips newline by default and keeps it when asked", () => {
		expect(stripControlChars("a\nb")).toBe("ab");
		expect(stripControlChars("a\nb", { keepNewlines: true })).toBe("a\nb");
		expect(stripControlChars("a\rb")).toBe("ab");
	});

	it("leaves ordinary text untouched", () => {
		expect(stripControlChars("plain text 123")).toBe("plain text 123");
	});
});

describe("sanitizeUiText", () => {
	it("does not truncate at exactly the limit", () => {
		expect(sanitizeUiText("abc", 3)).toBe("abc");
	});

	it("truncates to the limit with an ellipsis", () => {
		expect(sanitizeUiText("abcd", 3)).toBe("ab…");
		expect(sanitizeUiText("abcd", 1)).toBe("…");
		expect(sanitizeUiText("abc", 2.9)).toBe("a…");
	});

	it("returns empty for a zero or negative limit", () => {
		expect(sanitizeUiText("abc", 0)).toBe("");
		expect(sanitizeUiText("abc", -1)).toBe("");
	});

	it("collapses whitespace, strips newlines and trims", () => {
		expect(sanitizeUiText("a   b")).toBe("a b");
		expect(sanitizeUiText("a\nb")).toBe("ab");
		expect(sanitizeUiText("  padded  ")).toBe("padded");
		expect(sanitizeUiText("a\u0007b")).toBe("ab");
		expect(sanitizeUiText("a  \t b")).toBe("a b");
	});

	it("defaults the limit to 200 characters", () => {
		const long = "x".repeat(300);
		expect(sanitizeUiText(long)).toHaveLength(200);
		expect(sanitizeUiText(long).endsWith("…")).toBe(true);
	});

	it("strips terminal escape sequences", () => {
		expect(sanitizeUiText("evil\u0007name\u001b[31mred")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});
});

describe("sha256Hex", () => {
	it("hashes definition content deterministically", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("hashes bytes as well as strings", () => {
		expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
	});
});
