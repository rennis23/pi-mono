import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertPathInScope,
	describeScope,
	isPathInScope,
	isUnconfineable,
	isUnrestrictedCeiling,
	PATH_PARAM,
	resolveScope,
	ScopeRefusalError,
} from "./scope.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-scope-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function dir(...segments: string[]): string {
	const path = join(root, ...segments);
	mkdirSync(path, { recursive: true });
	// `tmpdir()` on macOS is a symlink (`/var` → `/private/var`), and the scope
	// module returns realpaths; compare against the canonical form.
	return realpathSync(path);
}

function expectRefusal(outcome: ReturnType<typeof resolveScope>, reason: string) {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) return;
	expect(outcome.reason).toBe(reason);
}

function expectOk(outcome: ReturnType<typeof resolveScope>) {
	if (!outcome.ok) throw new Error(`expected scope, got refusal: ${outcome.message}`);
	return outcome;
}

describe("resolveScope", () => {
	it("defaults an absent definition scope to the cwd", () => {
		const cwd = dir("project");
		const scope = expectOk(resolveScope({ cwd }));
		expect(scope.roots).toEqual([cwd]);
		expect(scope.unrestricted).toBe(false);
	});

	it("refuses an empty definition scope instead of treating it as unrestricted", () => {
		const cwd = dir("project");
		expectRefusal(resolveScope({ cwd, definitionScope: [] }), "scope-invalid");
	});

	it("refuses a scope entry that is cwd itself", () => {
		const cwd = dir("project");
		expectRefusal(resolveScope({ cwd, definitionScope: [cwd] }), "scope-invalid");
	});

	it("refuses a scope entry that is an ancestor of cwd", () => {
		const cwd = dir("project");
		expectRefusal(resolveScope({ cwd, definitionScope: [root] }), "scope-invalid");
	});

	it("refuses a scope entry outside the ceiling", () => {
		const cwd = dir("ceiling", "project");
		const sibling = dir("elsewhere");
		expectRefusal(
			resolveScope({ cwd, ceiling: [join(root, "ceiling")], definitionScope: [sibling] }),
			"scope-invalid",
		);
	});

	it("accepts a scope entry beneath the ceiling", () => {
		const cwd = dir("ceiling", "project");
		const sub = dir("ceiling", "sub");
		const scope = expectOk(resolveScope({ cwd, ceiling: [join(root, "ceiling")], definitionScope: [sub] }));
		expect(scope.roots).toEqual([sub]);
	});

	it("refuses a `..` escape", () => {
		const cwd = dir("project");
		dir("outside");
		expectRefusal(resolveScope({ cwd, definitionScope: ["../outside"] }), "scope-invalid");
	});

	it("refuses an absolute path outside the ceiling", () => {
		const cwd = dir("project");
		const outside = dir("outside");
		expectRefusal(resolveScope({ cwd, definitionScope: [outside] }), "scope-invalid");
	});

	it("refuses a symlink inside the ceiling that points outside it", () => {
		const cwd = dir("project");
		const outside = dir("outside");
		symlinkSync(outside, join(cwd, "link"));
		// The link resolves to a real directory, but that directory is outside the
		// ceiling, so realpath containment refuses it.
		expectRefusal(resolveScope({ cwd, definitionScope: [join(cwd, "link")] }), "scope-invalid");
	});

	it("refuses a nonexistent scope root", () => {
		const cwd = dir("project");
		expectRefusal(resolveScope({ cwd, definitionScope: [join(cwd, "missing")] }), "scope-invalid");
	});

	it("accepts and deduplicates multiple roots", () => {
		const cwd = dir("ceiling", "project");
		const a = dir("ceiling", "a");
		const b = dir("ceiling", "b");
		const scope = expectOk(resolveScope({ cwd, ceiling: [join(root, "ceiling")], definitionScope: [a, b, a] }));
		expect(scope.roots).toEqual([a, b]);
	});

	it("refuses a declaration that is outside an explicit ceiling", () => {
		const cwd = dir("one", "project");
		dir("two");
		expectRefusal(resolveScope({ cwd, ceiling: [join(root, "one")], definitionScope: ["../two"] }), "scope-invalid");
	});

	it("refuses an unconfineable vector under the default ceiling", () => {
		const cwd = dir("project");
		expectRefusal(
			resolveScope({ cwd, vector: { isolation: "process", sandbox: "none", tools: ["read", "bash"] } }),
			"scope-unenforceable",
		);
	});

	it("refuses subprocess isolation under the default ceiling", () => {
		const cwd = dir("project");
		expectRefusal(
			resolveScope({ cwd, vector: { isolation: "subprocess", sandbox: "none", tools: ["read"] } }),
			"scope-unenforceable",
		);
	});

	it("licenses an unconfineable vector under a `/` ceiling", () => {
		const cwd = dir("project");
		const scope = expectOk(
			resolveScope({
				cwd,
				ceiling: ["/"],
				vector: { isolation: "process", sandbox: "none", tools: ["bash"] },
			}),
		);
		expect(scope.unrestricted).toBe(true);
		expect(scope.roots).toEqual(["/"]);
	});

	it("refuses an explicitly narrowed scope with an unconfineable vector even under a `/` ceiling", () => {
		const cwd = dir("project");
		const sub = dir("project", "sub");
		expectRefusal(
			resolveScope({
				cwd,
				ceiling: ["/"],
				definitionScope: [sub],
				vector: { isolation: "process", sandbox: "none", tools: ["bash"] },
			}),
			"scope-unenforceable",
		);
	});

	it("allows a sandboxed bash under the default ceiling", () => {
		const cwd = dir("project");
		const scope = expectOk(resolveScope({ cwd, vector: { isolation: "process", sandbox: "os", tools: ["bash"] } }));
		expect(scope.roots).toEqual([cwd]);
		expect(scope.unrestricted).toBe(false);
	});

	it("names the fix in the unenforceable message", () => {
		const cwd = dir("project");
		const outcome = resolveScope({
			cwd,
			vector: { isolation: "process", sandbox: "none", tools: ["bash"] },
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("sandbox: os");
		expect(outcome.message).toContain('scope: ["/"]');
	});
});

describe("isPathInScope", () => {
	it("accepts a path beneath a root", () => {
		const root_ = dir("root");
		expect(isPathInScope([root_], join(root_, "file.txt"))).toBe(true);
	});

	it("refuses a sibling that shares a name prefix", () => {
		const root_ = dir("root");
		dir("rooted");
		expect(isPathInScope([root_], join(root, "rooted", "file.txt"))).toBe(false);
	});

	it("refuses a `..` escape", () => {
		const root_ = dir("root");
		dir("outside");
		expect(isPathInScope([root_], join(root_, "..", "outside", "file.txt"))).toBe(false);
	});

	it("refuses a symlink escape", () => {
		const root_ = dir("root");
		const outside = dir("outside");
		symlinkSync(outside, join(root_, "link"));
		expect(isPathInScope([root_], join(root_, "link", "file.txt"))).toBe(false);
	});

	it("treats `/` as containing every absolute path", () => {
		expect(isPathInScope(["/"], "/etc/hosts")).toBe(true);
	});

	it("accepts when any root contains the candidate", () => {
		const a = dir("a");
		const b = dir("b", "nested");
		expect(isPathInScope([a, b], join(b, "file.txt"))).toBe(true);
		expect(isPathInScope([a, b], join(root, "elsewhere", "file.txt"))).toBe(false);
	});
});

describe("assertPathInScope", () => {
	it("throws a typed error outside the roots", () => {
		const root_ = dir("root");
		expect(() => assertPathInScope([root_], join(root, "outside"), "read.path")).toThrow(ScopeRefusalError);
	});

	it("does not throw inside the roots", () => {
		const root_ = dir("root");
		expect(() => assertPathInScope([root_], join(root_, "file.txt"), "read.path")).not.toThrow();
	});
});

describe("isUnconfineable", () => {
	it("is true for unsandboxed bash", () => {
		expect(isUnconfineable({ isolation: "process", sandbox: "none", tools: ["read", "bash"] })).toBe(true);
	});

	it("is true for subprocess isolation", () => {
		expect(isUnconfineable({ isolation: "subprocess", sandbox: "os", tools: ["read"] })).toBe(true);
	});

	it("is false for sandboxed bash", () => {
		expect(isUnconfineable({ isolation: "process", sandbox: "os", tools: ["read", "bash"] })).toBe(false);
	});

	it("is false when bash is not granted", () => {
		expect(isUnconfineable({ isolation: "process", sandbox: "none", tools: ["read"] })).toBe(false);
	});
});

describe("isUnrestrictedCeiling", () => {
	it("is true only for a `/` root", () => {
		expect(isUnrestrictedCeiling(["/"])).toBe(true);
		expect(isUnrestrictedCeiling([root])).toBe(false);
		expect(isUnrestrictedCeiling(undefined)).toBe(false);
		expect(isUnrestrictedCeiling([])).toBe(false);
	});
});

describe("describeScope", () => {
	it("names the cwd, a single root, multiple roots and the host", () => {
		const cwd = dir("project");
		expect(describeScope([cwd], false, cwd)).toBe("cwd");
		expect(describeScope([cwd], false)).toBe(cwd);
		expect(describeScope([cwd, root], false)).toBe("2 roots");
		expect(describeScope(["/"], true)).toBe("host");
	});
});

describe("PATH_PARAM", () => {
	it("covers every bundled file tool with the `path` field", () => {
		expect(Object.keys(PATH_PARAM).sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
		for (const spec of Object.values(PATH_PARAM)) expect(spec.field).toBe("path");
	});
});
