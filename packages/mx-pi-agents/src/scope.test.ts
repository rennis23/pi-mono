import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	UNRESTRICTED_ROOT,
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

describe("scope: survivor kills", () => {
	it("names the ScopeRefusalError", () => {
		const err = new ScopeRefusalError("nope");
		expect(err.name).toBe("ScopeRefusalError");
		expect(err.reason).toBe("scope-invalid");
	});

	it("uses the cwd default when the ceiling is an empty list", () => {
		const cwd = dir("project");
		expect(expectOk(resolveScope({ cwd, ceiling: [] })).roots).toEqual([cwd]);
	});

	it("accepts a ceiling where at least one entry contains the cwd", () => {
		const cwd = dir("project");
		const other = dir("other");
		expect(expectOk(resolveScope({ cwd, ceiling: [other, cwd] })).roots).toEqual([cwd]);
	});

	it("names the ceiling in the cwd-outside-ceiling refusal", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, ceiling: [dir("other")] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("outside the configured scope ceiling");
	});

	it("names the empty-scope refusal", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, definitionScope: [] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("an empty scope is never");
	});

	it("names the cwd-itself refusal for cwd and empty entries", () => {
		const cwd = dir("project");
		for (const entry of [cwd, ""]) {
			const outcome = resolveScope({ cwd, definitionScope: [entry] });
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.message).toContain("must be a subdirectory of the run cwd, not cwd itself");
		}
	});

	it("names a / entry as an ancestor rather than an out-of-ceiling path", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, definitionScope: ["/"] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("ancestor of cwd");
	});

	it("names the ancestor refusal with the real root", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, definitionScope: [root] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.message).toContain("ancestor of cwd");
			expect(outcome.message).toContain(realpathSync(root));
		}
	});

	it("names a missing scope root", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, definitionScope: [join(cwd, "missing")] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("not an existing directory");
	});

	it("accepts a scope root contained by any ceiling entry", () => {
		const cwd = dir("ceiling", "project");
		const sub = dir("ceiling", "sub");
		const scope = expectOk(
			resolveScope({ cwd, ceiling: [join(root, "ceiling"), dir("other")], definitionScope: [sub] }),
		);
		expect(scope.roots).toEqual([sub]);
	});

	it("names the out-of-ceiling scope root", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, definitionScope: [dir("outside")] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("outside the configured scope ceiling");
	});

	it("states that an unconfineable run cannot be confined", () => {
		const cwd = dir("project");
		const outcome = resolveScope({ cwd, vector: { isolation: "process", sandbox: "none", tools: ["bash"] } });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("cannot be confined to a narrow path scope");
	});

	it("includes the root (not host) in the assertPathInScope error", () => {
		const root_ = dir("root");
		try {
			assertPathInScope([root_], join(root, "outside"), "read.path");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ScopeRefusalError);
			const message = (err as Error).message;
			expect(message).toContain("is outside the run scope");
			expect(message).toContain(root_);
			expect(message).not.toContain("scope (host)");
		}
	});
});

describe("scope: boundary hardening", () => {
	it("UNRESTRICTED_ROOT is the filesystem root", () => {
		expect(UNRESTRICTED_ROOT).toBe("/");
	});

	it("isUnrestrictedCeiling is true when any entry is the root", () => {
		const other = dir("x");
		expect(isUnrestrictedCeiling([other, "/"])).toBe(true);
		expect(isUnrestrictedCeiling([other])).toBe(false);
	});

	it("refuses the default cwd when it is outside the ceiling", () => {
		const cwd = dir("project");
		const other = dir("other");
		expectRefusal(resolveScope({ cwd, ceiling: [other] }), "scope-invalid");
	});

	it("refuses a scope root that is an existing file", () => {
		const cwd = dir("project");
		const file = join(cwd, "file.txt");
		writeFileSync(file, "x");
		expectRefusal(resolveScope({ cwd, definitionScope: [file] }), "scope-invalid");
	});

	it("refuses / as a scope root because it is an ancestor of cwd", () => {
		const cwd = dir("project");
		expectRefusal(resolveScope({ cwd, definitionScope: ["/"] }), "scope-invalid");
	});

	it("describeScope returns the root path when cwd differs", () => {
		const cwd = dir("project");
		const other = dir("other");
		expect(describeScope([other], false, cwd)).toBe(other);
	});

	it("PATH_PARAM records the read/write mode per tool", () => {
		expect(PATH_PARAM.read.mode).toBe("read");
		expect(PATH_PARAM.ls.mode).toBe("read");
		expect(PATH_PARAM.write.mode).toBe("write");
		expect(PATH_PARAM.edit.mode).toBe("write");
	});
});
