import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createReadToolDefinition,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeRefusalError } from "../scope.js";
import type { RunPlan } from "../types.js";
import { buildGrantedTools, confineToolDefinition, isConfinedToolName } from "./confine.js";

let root: string;
let inside: string;
let outside: string;

beforeEach(() => {
	// `tmpdir()` is a symlink on macOS; realpath so scope containment matches.
	root = realpathSync(mkdtempSync(join(tmpdir(), "mx-pi-agents-confine-")));
	inside = join(root, "inside");
	outside = join(root, "outside");
	mkdirSync(inside, { recursive: true });
	mkdirSync(outside, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const ctx = {} as ExtensionToolContext;

function fakeDefinition(name: string, execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))) {
	return { name, label: name, description: name, parameters: {} as never, execute } as unknown as ToolDefinition<
		any,
		any,
		any
	>;
}

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
	return {
		agentName: "explorer",
		source: { kind: "global", path: "/agents/explorer.md", directory: "/agents", trusted: true },
		task: "task",
		tools: ["read"],
		noTools: undefined,
		model: undefined,
		thinking: undefined,
		systemPrompt: "prompt",
		budgets: { maxTurns: 5, timeoutMs: 5000, tokenBudget: 1000, costBudget: undefined },
		isolation: "process",
		sandbox: "none",
		cwd: root,
		scope: { roots: [root], unrestricted: false },
		diagnostics: [],
		...overrides,
	};
}

describe("confineToolDefinition", () => {
	const fileToolNames = ["read", "write", "edit", "ls", "grep", "find"] as const;

	it("refuses an out-of-scope path for every bundled file tool", async () => {
		for (const name of fileToolNames) {
			const base = fakeDefinition(name);
			const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
			await expect(
				wrapped.execute("c", { path: join(outside, "f.txt") }, undefined, undefined, ctx),
			).rejects.toBeInstanceOf(ScopeRefusalError);
			expect(base.execute).not.toHaveBeenCalled();
		}
	});

	it("refuses a `..` escape", async () => {
		const base = fakeDefinition("read");
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
		await expect(
			wrapped.execute("c", { path: join(inside, "..", "outside", "f.txt") }, undefined, undefined, ctx),
		).rejects.toBeInstanceOf(ScopeRefusalError);
	});

	it("refuses an absolute path outside the roots", async () => {
		const base = fakeDefinition("write");
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "write" });
		await expect(wrapped.execute("c", { path: outside }, undefined, undefined, ctx)).rejects.toBeInstanceOf(
			ScopeRefusalError,
		);
	});

	it("resolves an absent or empty path to the cwd", async () => {
		const base = fakeDefinition("read");
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
		await wrapped.execute("c", {}, undefined, undefined, ctx);
		await wrapped.execute("c", { path: "" }, undefined, undefined, ctx);
		await wrapped.execute("c", { path: "   " }, undefined, undefined, ctx);
		expect(base.execute).toHaveBeenCalledTimes(3);
	});

	it("passes an in-scope path through to the wrapped definition", async () => {
		const base = fakeDefinition("read");
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
		const result = await wrapped.execute("c", { path: join(inside, "f.txt") }, undefined, undefined, ctx);
		expect(base.execute).toHaveBeenCalledOnce();
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	it("refuses an unrecognized parameter shape instead of passing through", async () => {
		const base = fakeDefinition("read");
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
		await expect(wrapped.execute("c", null as never, undefined, undefined, ctx)).rejects.toBeInstanceOf(
			ScopeRefusalError,
		);
		await expect(wrapped.execute("c", "nope" as never, undefined, undefined, ctx)).rejects.toBeInstanceOf(
			ScopeRefusalError,
		);
		await expect(wrapped.execute("c", { path: 42 } as never, undefined, undefined, ctx)).rejects.toBeInstanceOf(
			ScopeRefusalError,
		);
		expect(base.execute).not.toHaveBeenCalled();
	});

	it("produces the same result as the unwrapped definition for an in-scope read", async () => {
		const file = join(inside, "hello.txt");
		writeFileSync(file, "hello world\n");
		const base = createReadToolDefinition(inside);
		const wrapped = confineToolDefinition(base, { cwd: inside, roots: [inside], mode: "read" });
		const direct = await base.execute("c", { path: file }, undefined, undefined, ctx);
		const confined = await wrapped.execute("c", { path: file }, undefined, undefined, ctx);
		expect(confined.content).toEqual(direct.content);
	});
});

describe("buildGrantedTools", () => {
	it("wraps every granted file tool and never bash", () => {
		const defs = buildGrantedTools(plan({ tools: ["read", "grep", "find", "ls", "write", "edit", "bash"] }));
		expect(defs.map((definition) => definition.name).sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
		expect(isConfinedToolName("bash")).toBe(false);
	});

	it("derives the wrapper set from the grant, so an ungranted tool is absent", () => {
		const defs = buildGrantedTools(plan({ tools: ["read"] }));
		expect(defs.map((definition) => definition.name)).toEqual(["read"]);
	});

	it("returns no wrappers for an unrestricted run", () => {
		const defs = buildGrantedTools(plan({ tools: ["read", "write"], scope: { roots: ["/"], unrestricted: true } }));
		expect(defs).toEqual([]);
	});
});
