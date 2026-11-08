/**
 * Static source-structure assertions for the extension entrypoint.
 *
 * These tests read `index.ts` as text, so they are deliberately excluded from
 * the Stryker mutation run (see `vitest.stryker.config.ts` at the repo root):
 * Stryker rewrites sandbox sources with coverage and mutant-switching
 * instrumentation, which makes exact substring matching meaningless.
 *
 * Behavioural coverage of the same invariants lives in `security.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("invariant 7: child output is capped data that cannot trigger a parent turn", () => {
	it("returns tool results as data; only an interactive directive can trigger a turn", () => {
		// Structural: the tool result path never pushes a session message. The one
		// `pi.sendMessage` call is the user-initiated `#` directive, and it is
		// gated on an interactive source earlier in the handler.
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		expect(source).not.toContain("sendUserMessage(");
		const sendIndex = source.indexOf("pi.sendMessage(");
		expect(sendIndex).toBeGreaterThan(-1);
		expect(source.indexOf("pi.sendMessage(", sendIndex + 1)).toBe(-1);
		const gateIndex = source.indexOf('event.source !== "interactive"');
		expect(gateIndex).toBeGreaterThan(-1);
		expect(gateIndex).toBeLessThan(sendIndex);
		expect(source).toContain("triggerTurn:");
	});
});

describe("invariant 8: children cannot spawn children", () => {
	it("refuses to register inside a marked child", () => {
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		expect(source).toContain("MX_PI_AGENTS_CHILD");
		// The guard is a top-level early return, before any registration.
		const guardIndex = source.indexOf("CHILD_ENV_MARKER] === CHILD_MARKER_VALUE");
		const registerIndex = source.indexOf("registerTool({");
		expect(guardIndex).toBeGreaterThan(-1);
		expect(guardIndex).toBeLessThan(registerIndex);
	});
});
