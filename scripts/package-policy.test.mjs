import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverPackages,
	forbiddenTarballPath,
	validateManifest,
	validatePackage,
	validateTarballFiles,
} from "./package-policy.mjs";

const temporaryDirectories = [];

async function makePackage(manifestOverrides = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-package-policy-"));
	temporaryDirectories.push(root);
	const packageDir = join(root, "packages", "mx-pi-demo");
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(packageDir, "index.ts"), "export default function extension() {}\n");
	await writeFile(join(packageDir, "README.md"), "# Demo\n");
	await writeFile(join(packageDir, "LICENSE"), "MIT\n");
	await writeFile(join(packageDir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
	await writeFile(
		join(packageDir, "SECURITY.md"),
		"# Security\n\nThreat model. Enforced controls. Not enforced. Residual risk. Report issues.\n",
	);
	const manifest = {
		name: "@rennis23/mx-pi-demo",
		version: "0.1.0",
		publishConfig: { access: "public" },
		files: ["index.ts", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"],
		pi: { extensions: ["./index.ts"] },
		...manifestOverrides,
	};
	await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
	return { root, packageDir, manifest };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("discoverPackages", () => {
	it("discovers direct package workspaces without traversing sandbox", async () => {
		const { root, packageDir } = await makePackage();
		await mkdir(join(root, "sandbox", "fake-package"), { recursive: true });
		await writeFile(join(root, "sandbox", "fake-package", "package.json"), "{}");

		expect(discoverPackages(join(root, "packages"))).toEqual([packageDir]);
	});
});

describe("validateManifest", () => {
	it("accepts a public extension manifest with required files", async () => {
		const { packageDir, manifest } = await makePackage();

		expect(validateManifest(manifest, packageDir)).toEqual([]);
	});

	it("rejects unsafe names, lifecycle scripts, and extension escapes", async () => {
		const { packageDir, manifest } = await makePackage({
			name: "unsafe-package",
			pi: { extensions: ["../outside.ts"] },
			scripts: { prepare: "echo unsafe" },
		});

		const errors = validateManifest(manifest, packageDir);
		expect(errors).toEqual(
			expect.arrayContaining([
				"name must match @rennis23/mx-pi-<name> (received unsafe-package)",
				"pi extension escapes the package: ../outside.ts",
				"install-time lifecycle script is forbidden: prepare",
			]),
		);
	});
});

describe("tarball policy", () => {
	it("identifies forbidden published paths", () => {
		expect(forbiddenTarballPath("package/src/index.test.ts")).toBe("test source");
		expect(forbiddenTarballPath("package/test/fixture.json")).toBe("development directory");
		expect(forbiddenTarballPath("package/.env")).toBe("sensitive or repository metadata");
		expect(forbiddenTarballPath("package/index.ts")).toBeUndefined();
	});

	it("reports forbidden files from npm pack output", () => {
		expect(validateTarballFiles([{ path: "package/index.ts" }, { path: "package/src/demo.test.ts" }])).toEqual([
			"package/src/demo.test.ts: forbidden test source",
		]);
	});

	it("validates an injected pack result without invoking npm", async () => {
		const { packageDir } = await makePackage();
		const result = validatePackage(packageDir, {
			pack: () =>
				["index.ts", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"].map((path) => ({
					path: `package/${path}`,
				})),
		});

		expect(result).toEqual({ packageName: "@rennis23/mx-pi-demo", errors: [] });
	});
});
