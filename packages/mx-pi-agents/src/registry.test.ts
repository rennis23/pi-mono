import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAgents,
	findAgent,
	pinRegistry,
	type RegistryDirs,
	realDirectoryOf,
	rosterEntries,
	verifyPinned,
} from "./registry.js";

let root: string;
let agentDir: string;
let cwd: string;
let configDir: string;
let emptyBundled: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-registry-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	configDir = join(root, "extra");
	emptyBundled = join(root, "bundled");
	mkdirSync(emptyBundled, { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeDefinition(dir: string, file: string, name: string, extra = ""): string {
	const path = join(dir, file);
	writeFileSync(
		path,
		`---\nname: ${name}\ndescription: ${name} description\ntools: [read]\n${extra}---\n\nBody for ${name}.\n`,
	);
	return path;
}

function dirs(overrides: Partial<RegistryDirs> = {}): RegistryDirs {
	return { agentDir, cwd, agentPaths: [], bundledDir: emptyBundled, ...overrides };
}

describe("discoverAgents", () => {
	it("finds global and project definitions with the right source kinds", () => {
		writeDefinition(join(agentDir, "agents"), "g.md", "global-agent");
		writeDefinition(join(cwd, ".pi", "agents"), "p.md", "project-agent");

		const { agents } = discoverAgents(dirs(), () => 1000);
		const global = findAgent(agents, "global-agent");
		const project = findAgent(agents, "project-agent");

		expect(global?.source.kind).toBe("global");
		expect(global?.source.trusted).toBe(true);
		expect(project?.source.kind).toBe("project");
		expect(project?.source.trusted).toBe(false);
	});

	it("scans config agentPaths in config order", () => {
		const first = join(root, "one");
		const second = join(root, "two");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		writeDefinition(first, "a.md", "first-agent");
		writeDefinition(second, "b.md", "second-agent");

		const { agents } = discoverAgents(dirs({ agentPaths: [first, second] }), () => 1);
		expect(findAgent(agents, "first-agent")?.source.kind).toBe("config");
		expect(findAgent(agents, "second-agent")?.source.kind).toBe("config");
	});

	it("drops a gated definition that shadows a trusted one", () => {
		writeDefinition(join(agentDir, "agents"), "trusted.md", "reviewer");
		const shadowPath = writeDefinition(join(cwd, ".pi", "agents"), "shadow.md", "reviewer");

		const { agents, shadowed, diagnostics } = discoverAgents(dirs(), () => 1);
		expect(agents).toHaveLength(1);
		expect(agents[0].source.kind).toBe("global");
		expect(shadowed).toHaveLength(1);
		expect(shadowed[0].path).toBe(shadowPath);
		expect(diagnostics.some((d) => d.message.includes("shadow"))).toBe(true);
	});

	it("keeps the trusted definition when a gated config definition shares its name", () => {
		// Discovery order is bundled, global, config, project: the gated config
		// entry arrives second and is dropped as a shadow rather than overriding.
		writeDefinition(join(configDir), "c.md", "reviewer");
		writeDefinition(join(agentDir, "agents"), "g.md", "reviewer");

		const { agents, shadowed, diagnostics } = discoverAgents(dirs({ agentPaths: [configDir] }), () => 1);
		expect(agents).toHaveLength(1);
		expect(agents[0].source.kind).toBe("global");
		expect(shadowed).toHaveLength(1);
		expect(diagnostics.some((d) => d.message.includes("shadow"))).toBe(true);
	});

	it("keeps the first of two definitions in the same trust class", () => {
		writeDefinition(join(cwd, ".pi", "agents"), "a.md", "dup");
		writeDefinition(join(configDir), "b.md", "dup");

		const { agents } = discoverAgents(dirs({ agentPaths: [configDir] }), () => 1);
		expect(agents).toHaveLength(1);
		expect(agents[0].source.path).toBe(join(configDir, "b.md"));
	});

	it("drops unparseable definitions with a diagnostic", () => {
		writeFileSync(join(agentDir, "agents", "bad.md"), "---\nname: bad\n---\nno description\n");
		writeDefinition(join(agentDir, "agents"), "good.md", "good");

		const { agents, diagnostics } = discoverAgents(dirs(), () => 1);
		expect(agents.map((a) => a.definition.name)).toEqual(["good"]);
		expect(diagnostics.some((d) => d.level === "warning" && d.message.includes("dropped definition"))).toBe(true);
	});

	it("ignores non-markdown files and dotfiles", () => {
		writeFileSync(join(agentDir, "agents", "notes.txt"), "not a definition");
		writeFileSync(join(agentDir, "agents", ".hidden.md"), "---\nname: h\ndescription: d\n---\nbody");
		writeDefinition(join(agentDir, "agents"), "real.md", "real");

		const { agents } = discoverAgents(dirs(), () => 1);
		expect(agents.map((a) => a.definition.name)).toEqual(["real"]);
	});

	it("returns an empty roster for missing directories", () => {
		const { agents, diagnostics } = discoverAgents(
			{
				agentDir: join(root, "nope"),
				cwd: join(root, "also-nope"),
				agentPaths: [join(root, "gone")],
				bundledDir: emptyBundled,
			},
			() => 1,
		);
		expect(agents).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("records the real directory of each definition", () => {
		const path = writeDefinition(join(cwd, ".pi", "agents"), "p.md", "p");
		const { agents } = discoverAgents(dirs(), () => 1);
		expect(agents[0].source.directory).toBe(realDirectoryOf(path));
	});

	it("discovers the shipped bundled agents by default", () => {
		// No bundledDir override: this exercises the real package layout, so a
		// broken `agents/**` glob or a moved directory fails the build.
		const { agents, diagnostics } = discoverAgents({ agentDir, cwd, agentPaths: [] }, () => 1);
		const names = agents.map((agent) => agent.definition.name);
		for (const expected of ["explorer", "planner", "reviewer", "builder"]) {
			expect(names).toContain(expected);
		}
		expect(diagnostics.filter((d) => d.level === "warning")).toEqual([]);
	});

	it("never grants a spawn-capable tool to a bundled agent", () => {
		const { agents } = discoverAgents({ agentDir, cwd, agentPaths: [] }, () => 1);
		for (const agent of agents) {
			expect(agent.definition.tools ?? []).not.toContain("mx_pi_agent");
		}
	});

	it("sorts the roster by name", () => {
		writeDefinition(join(agentDir, "agents"), "z.md", "zeta");
		writeDefinition(join(agentDir, "agents"), "a.md", "alpha");
		const { agents } = discoverAgents(dirs(), () => 1);
		expect(agents.map((a) => a.definition.name)).toEqual(["alpha", "zeta"]);
	});
});

describe("pinRegistry", () => {
	it("pins definitions with hashes and a timestamp", () => {
		writeDefinition(join(agentDir, "agents"), "a.md", "alpha");
		const { snapshot } = pinRegistry(dirs(), () => 4242);
		expect(snapshot.pinnedAt).toBe(4242);
		expect(snapshot.agents[0].hash).toMatch(/^[0-9a-f]{64}$/);
		expect(snapshot.agents[0].pinnedAt).toBe(4242);
	});

	it("stamps a timestamp even with no agents", () => {
		const { snapshot } = pinRegistry(dirs(), () => 77);
		expect(snapshot.pinnedAt).toBe(77);
	});
});

describe("verifyPinned", () => {
	it("accepts an unchanged definition", () => {
		writeDefinition(join(agentDir, "agents"), "a.md", "alpha");
		const { snapshot } = pinRegistry(dirs(), () => 1);
		const result = verifyPinned(snapshot.agents[0]);
		expect(result.ok).toBe(true);
	});

	it("refuses when the file changed after pinning", () => {
		const path = writeDefinition(join(agentDir, "agents"), "a.md", "alpha");
		const { snapshot } = pinRegistry(dirs(), () => 1);
		writeFileSync(path, "---\nname: alpha\ndescription: changed\ntools: [bash]\n---\n\nNew body.\n");

		const result = verifyPinned(snapshot.agents[0]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("changed");
		expect(result.message).toContain("changed since session start");
	});

	it("refuses when the file is gone", () => {
		const path = writeDefinition(join(agentDir, "agents"), "a.md", "alpha");
		const { snapshot } = pinRegistry(dirs(), () => 1);
		rmSync(path);

		const result = verifyPinned(snapshot.agents[0]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("missing");
	});

	it("detects a capability widening even when the body is unchanged", () => {
		const path = writeDefinition(join(agentDir, "agents"), "a.md", "alpha", "max_turns: 5\n");
		const { snapshot } = pinRegistry(dirs(), () => 1);
		writeFileSync(
			path,
			"---\nname: alpha\ndescription: alpha description\ntools: [read, bash, write]\nmax_turns: 5\n---\n\nBody for alpha.\n",
		);

		expect(verifyPinned(snapshot.agents[0]).ok).toBe(false);
	});
});

describe("rosterEntries", () => {
	it("sanitizes hostile text for display", () => {
		const path = join(agentDir, "agents", "evil.md");
		writeFileSync(path, `---\nname: evil\ndescription: "bad\\u0007desc"\ntools: [read]\n---\n\nbody`);
		const { snapshot } = pinRegistry(dirs(), () => 1);
		const entries = rosterEntries(snapshot.agents);
		expect(entries[0].description).not.toContain("\u0007");
		expect(entries[0].hash).toHaveLength(12);
	});

	it("reports inherit rules when tools is absent", () => {
		writeFileSync(join(agentDir, "agents", "i.md"), "---\nname: i\ndescription: d\n---\n\nbody");
		const { snapshot } = pinRegistry(dirs(), () => 1);
		expect(rosterEntries(snapshot.agents)[0].tools).toBeUndefined();
	});
});
