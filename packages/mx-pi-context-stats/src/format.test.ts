import { describe, expect, it } from "vitest";
import { compactTools, fmt, fmtCost, fmtDuration, fmtPct, fmtRate, shortModel } from "./format.js";

describe("fmt", () => {
	it("renders small counts verbatim", () => {
		expect(fmt(0)).toBe("0");
		expect(fmt(1)).toBe("1");
		expect(fmt(999)).toBe("999");
		expect(fmt(812)).toBe("812");
	});

	it("switches to one decimal at 1k", () => {
		expect(fmt(1000)).toBe("1.0k");
		expect(fmt(8123)).toBe("8.1k");
		expect(fmt(99_999)).toBe("100.0k");
	});

	it("drops the decimal at 100k", () => {
		expect(fmt(100_000)).toBe("100k");
		expect(fmt(812_345)).toBe("812k");
	});

	it("never prints NaN or Infinity", () => {
		expect(fmt(Number.NaN)).toBe("0");
		expect(fmt(Number.POSITIVE_INFINITY)).toBe("0");
	});

	it("keeps the sign for negative input", () => {
		expect(fmt(-1500)).toBe("-1.5k");
	});
});

describe("fmtDuration", () => {
	it("prints sub-minute durations without a minute part", () => {
		expect(fmtDuration(0)).toBe("0.0s");
		expect(fmtDuration(5.24)).toBe("5.2s");
		expect(fmtDuration(59.9)).toBe("59.9s");
	});

	it("prints minutes and seconds above a minute", () => {
		expect(fmtDuration(60)).toBe("1m 0.0s");
		expect(fmtDuration(65.2)).toBe("1m 5.2s");
	});

	it("guards against non-finite and negative input", () => {
		expect(fmtDuration(Number.NaN)).toBe("0.0s");
		expect(fmtDuration(-3)).toBe("0.0s");
	});
});

describe("fmtCost", () => {
	it("shows 4 decimals for sub-cent costs", () => {
		expect(fmtCost(0.0042)).toBe("$0.0042");
	});

	it("shows 3 decimals below a dollar", () => {
		expect(fmtCost(0.012)).toBe("$0.012");
		expect(fmtCost(0.5)).toBe("$0.500");
	});

	it("shows 2 decimals at a dollar and above", () => {
		expect(fmtCost(1)).toBe("$1.00");
		expect(fmtCost(12.345)).toBe("$12.35");
	});

	it("treats zero, negative and non-finite as zero", () => {
		expect(fmtCost(0)).toBe("$0.000");
		expect(fmtCost(-1)).toBe("$0.000");
		expect(fmtCost(Number.NaN)).toBe("$0.000");
	});
});

describe("fmtPct", () => {
	it("computes a one-decimal percentage", () => {
		expect(fmtPct(82_000, 128_000)).toBe("64.1%");
		expect(fmtPct(0, 128_000)).toBe("0.0%");
	});

	it("returns ?% when the window is unknown", () => {
		expect(fmtPct(1000, 0)).toBe("?%");
		expect(fmtPct(1000, Number.NaN)).toBe("?%");
		expect(fmtPct(Number.NaN, 128_000)).toBe("?%");
	});

	it("clamps negative token counts to zero", () => {
		expect(fmtPct(-5, 100)).toBe("0.0%");
	});
});

describe("fmtRate", () => {
	it("formats tokens per minute", () => {
		expect(fmtRate(1180)).toBe("1.2k/min");
		expect(fmtRate(900)).toBe("900/min");
	});
});

describe("shortModel", () => {
	it("strips the provider prefix and the claude- prefix", () => {
		expect(shortModel("anthropic/claude-sonnet-4-5")).toBe("sonnet-4-5");
		expect(shortModel("claude-opus-4-6")).toBe("opus-4-6");
		expect(shortModel("openai/gpt-5")).toBe("gpt-5");
	});

	it("falls back to ? when unknown", () => {
		expect(shortModel(undefined)).toBe("?");
		expect(shortModel("")).toBe("?");
	});
});

describe("compactTools", () => {
	it("joins short lists", () => {
		expect(compactTools(["read", "grep"])).toBe("read,grep");
	});

	it("summarizes the tail with the real hidden count", () => {
		expect(compactTools(["read", "grep", "find", "ls", "bash"])).toBe("read,grep,find+2");
		expect(compactTools(["a", "b", "c", "d", "e"], 3)).toBe("a,b+3");
	});

	it("handles empty and degenerate input", () => {
		expect(compactTools([])).toBe("");
		expect(compactTools(["read"], 0)).toBe("read");
	});
});
