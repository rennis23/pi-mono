/**
 * Shipped-artifact contract tests.
 *
 * Every other suite in this package builds fixture agents in a temp dir and
 * exercises pure logic. These tests are the deliberate exception: they call
 * `discoverAgents` without a `bundledDir` override, so they read the `.md` files
 * that the package actually ships in `packages/mx-pi-agents/agents`.
 *
 * That coupling is the point. Properties like "the bundled set is exactly
 * socrates" are statements about the shipped content, and no fake agent can
 * cover them — a fixture would stay green while someone adds an unreviewed
 * definition. Keep logic tests in their own suites; add shipped-content
 * assertions here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./registry.js";

/** The roster every release of this package is expected to ship. */
const EXPECTED_BUNDLED_AGENTS = ["socrates"];

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
	it("discovers exactly the shipped bundled agents by default", () => {
		// No bundledDir override: this exercises the real package layout, so a
		// broken `agents/**` glob or a moved directory fails the build.
		const { agents, diagnostics } = bundledAgents();
		expect(agents.map((agent) => agent.definition.name)).toEqual(EXPECTED_BUNDLED_AGENTS);
		expect(diagnostics.filter((d) => d.level === "warning")).toEqual([]);
	});

	it("ships socrates as a replace persona with no tools, skills or context files", () => {
		const { agents } = bundledAgents();
		const socrates = agents.find((agent) => agent.definition.name === "socrates");
		expect(socrates?.definition.systemPrompt).toBe("replace");
		expect(socrates?.definition.tools).toEqual([]);
		expect(socrates?.definition.skills).toEqual([]);
		expect(socrates?.definition.contextFiles).toEqual([]);
		expect(socrates?.source.kind).toBe("bundled");
		expect(socrates?.source.trusted).toBe(true);
	});

	it("names every shipped definition file after its frontmatter name", () => {
		const { agents } = bundledAgents();
		for (const agent of agents) {
			const base = basename(agent.source.path);
			const stem = base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
			const expected = agent.definition.name;
			expect(stem, `definition file "${base}" must be named "${expected}.md"`).toBe(expected);
		}
	});
});
