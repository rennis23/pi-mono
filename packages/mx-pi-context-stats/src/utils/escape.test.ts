import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escape.js";

describe("escapeHtml", () => {
	it("escapes special characters", () => {
		expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
		expect(escapeHtml("a & b")).toBe("a &amp; b");
		expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
		expect(escapeHtml("'test'")).toBe("&#039;test&#039;");
	});

	it("handles undefined and null", () => {
		expect(escapeHtml(undefined)).toBe("");
		expect(escapeHtml(null)).toBe("");
	});
});
