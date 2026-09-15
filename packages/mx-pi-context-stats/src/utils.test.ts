import { describe, expect, it } from "vitest";
import { escapeHtml } from "./utils.js";

describe("escapeHtml", () => {
	it("escapes HTML characters", () => {
		expect(escapeHtml("<script>alert('XSS')</script>")).toBe("&lt;script&gt;alert(&#039;XSS&#039;)&lt;/script&gt;");
		expect(escapeHtml("a & b")).toBe("a &amp; b");
		expect(escapeHtml('foo "bar"')).toBe("foo &quot;bar&quot;");
	});

	it("handles null and undefined", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("");
	});

	it("handles non-string inputs", () => {
		expect(escapeHtml(123 as any)).toBe("123");
	});
});
