/**
 * Shipped-artifact contract tests.
 *
 * Every other suite in this package builds fixture agents in a temp dir and
 * exercises pure logic. These tests are the deliberate exception: they call
 * `discoverAgents` without a `bundledDir` override, so they read the `.md` files
 * that the package actually ships in `packages/mx-pi-agents/agents`.
 *
 * That coupling is the point. Properties like "no bundled agent grants a
 * spawn-capable tool" are statements about the shipped content, and no fake
 * agent can cover them — a fixture would stay green while someone edits
 * `explorer.md` into an unbounded-recursion agent. Keep logic tests in their own
 * suites; add shipped-content assertions here.
 *
 * Behavioural coverage of invariant 8 (a definition that grants a spawn tool is
 * refused) lives in `security.test.ts` and `policy.test.ts` against fixtures.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./registry.js";

/** The roster every release of this package is expected to ship. */
const EXPECTED_BUNDLED_AGENTS = ["explorer", "planner", "reviewer", "builder", "socrates"];

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-bundled-"));
	// Empty user dirs plus no `bundledDir` override: only shipped agents resolve.
	agentDir = join(root, "agent");
	cwd = join(root, "project");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function bundledAgents() {
	return discoverAgents({ agentDir, cwd, agentPaths: [] }, () => 1);
}

describe("bundled agent artifacts", () => {
	it("discovers the shipped bundled agents by default", () => {
		// No bundledDir override: this exercises the real package layout, so a
		// broken `agents/**` glob or a moved directory fails the build.
		const { agents, diagnostics } = bundledAgents();
		const names = agents.map((agent) => agent.definition.name);
		for (const expected of EXPECTED_BUNDLED_AGENTS) {
			expect(names).toContain(expected);
		}
		expect(diagnostics.filter((d) => d.level === "warning")).toEqual([]);
	});

	it("invariant 8: no bundled agent grants a spawn-capable tool", () => {
		const { agents } = bundledAgents();
		for (const agent of agents) {
			expect(agent.definition.tools ?? []).not.toContain("mx_pi_agent");
		}
	});

	it("ships socrates as a persona with no tools, skills or context files", () => {
		const { agents } = bundledAgents();
		const socrates = agents.find((agent) => agent.definition.name === "socrates");
		expect(socrates?.definition.kind).toBe("persona");
		expect(socrates?.definition.tools).toEqual([]);
		expect(socrates?.definition.skills).toEqual([]);
		expect(socrates?.definition.contextFiles).toEqual([]);
	});
});
