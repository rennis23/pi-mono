#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGES_ROOT = join(REPOSITORY_ROOT, "packages");
const REQUIRED_FILES = ["README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"];
const FORBIDDEN_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const PACKAGE_NAME = /^@rennis23\/mx-pi-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isInside(parent, child) {
	const path = relative(resolve(parent), resolve(child));
	return path !== "" && !path.startsWith(`..${pathSeparator()}`) && path !== ".." && !isAbsolute(path);
}

function pathSeparator() {
	return process.platform === "win32" ? "\\" : "/";
}

function readManifest(packageDir) {
	const manifestPath = join(packageDir, "package.json");
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`${manifestPath}: cannot parse package.json: ${error.message}`);
	}
}

export function discoverPackages(packagesRoot = PACKAGES_ROOT) {
	if (!existsSync(packagesRoot)) return [];
	return readdirSync(packagesRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
		.map((entry) => join(packagesRoot, entry.name))
		.sort();
}

export function validateManifest(manifest, packageDir) {
	const errors = [];
	const packageName = typeof manifest.name === "string" ? manifest.name : "<missing name>";

	if (typeof manifest.name !== "string" || !PACKAGE_NAME.test(manifest.name)) {
		errors.push(`name must match @rennis23/mx-pi-<name> (received ${packageName})`);
	}
	if (manifest.private === true) errors.push("public extension packages must not be private");
	if (manifest.publishConfig?.access !== "public") errors.push("publishConfig.access must be public");
	if (
		!Array.isArray(manifest.files) ||
		manifest.files.length === 0 ||
		manifest.files.some((file) => typeof file !== "string")
	) {
		errors.push("files must be a non-empty array of path patterns");
	}

	const extensions = manifest.pi?.extensions;
	if (
		!Array.isArray(extensions) ||
		extensions.length === 0 ||
		extensions.some((extension) => typeof extension !== "string")
	) {
		errors.push("pi.extensions must be a non-empty array of strings");
	} else {
		for (const extension of extensions) {
			const extensionPath = resolve(packageDir, extension);
			if (!isInside(packageDir, extensionPath)) {
				errors.push(`pi extension escapes the package: ${extension}`);
			} else if (!existsSync(extensionPath)) {
				errors.push(`pi extension does not exist: ${extension}`);
			}
		}
	}

	for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
		if (typeof manifest.scripts?.[script] === "string")
			errors.push(`install-time lifecycle script is forbidden: ${script}`);
	}

	for (const requiredFile of REQUIRED_FILES) {
		if (!existsSync(join(packageDir, requiredFile))) errors.push(`required file is missing: ${requiredFile}`);
	}

	if (existsSync(join(packageDir, "CHANGELOG.md"))) {
		const changelog = readFileSync(join(packageDir, "CHANGELOG.md"), "utf8");
		if (!/^##?\s*\[Unreleased\]/im.test(changelog)) errors.push("CHANGELOG.md must contain an [Unreleased] section");
	}
	if (existsSync(join(packageDir, "SECURITY.md"))) {
		const security = readFileSync(join(packageDir, "SECURITY.md"), "utf8").toLowerCase();
		for (const phrase of ["threat", "enforced", "not enforced", "residual", "report"]) {
			if (!security.includes(phrase)) errors.push(`SECURITY.md must describe: ${phrase}`);
		}
	}

	return errors;
}

export function forbiddenTarballPath(filePath) {
	const path = filePath.replace(/^package\//, "");
	const lower = path.toLowerCase();
	if (/(^|\/)(test|tests|fixtures|node_modules|dist|coverage|reports|\.pi)(\/|$)/.test(lower))
		return "development directory";
	if (/(^|\/)(\.git|\.env(?:\.|$))/.test(lower)) return "sensitive or repository metadata";
	if (/\.test\.(?:c|m)?(?:j|t)s$/.test(lower)) return "test source";
	if (/(^|\/)(plan|todo)(?:\.|\/|$)/.test(lower)) return "repository planning file";
	return undefined;
}

export function validateTarballFiles(files) {
	const errors = [];
	for (const file of files) {
		const path = typeof file === "string" ? file : file?.path;
		if (typeof path !== "string") {
			errors.push("npm pack returned an entry without a path");
			continue;
		}
		const reason = forbiddenTarballPath(path);
		if (reason) errors.push(`${path}: forbidden ${reason}`);
	}
	return errors;
}

function packWorkspace(packageDir, packageName) {
	const workspace = relative(REPOSITORY_ROOT, packageDir);
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", workspace], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let result;
	try {
		result = JSON.parse(output);
	} catch (error) {
		throw new Error(`${packageName}: npm pack returned invalid JSON: ${error.message}`);
	}
	const files = Array.isArray(result) ? result.flatMap((entry) => entry.files ?? []) : result.files;
	if (!Array.isArray(files)) throw new Error(`${packageName}: npm pack JSON did not contain a files array`);
	return files;
}

export function validatePackage(packageDir, { pack = packWorkspace } = {}) {
	const manifest = readManifest(packageDir);
	const errors = validateManifest(manifest, packageDir);
	if (errors.length > 0) return { packageName: manifest.name ?? packageDir, errors };

	try {
		const files = pack(packageDir, manifest.name);
		const errors = validateTarballFiles(files);
		const packedPaths = new Set(
			files
				.map((file) => (typeof file === "string" ? file : file?.path))
				.filter((file) => typeof file === "string")
				.map((file) => file.replace(/^package\//, "")),
		);
		for (const requiredFile of REQUIRED_FILES) {
			if (!packedPaths.has(requiredFile))
				errors.push(`${requiredFile}: required file is not included in the npm artifact`);
		}
		return { packageName: manifest.name, errors };
	} catch (error) {
		return { packageName: manifest.name, errors: [error.message] };
	}
}

function main() {
	const packageDirs = discoverPackages();
	if (packageDirs.length === 0) throw new Error("no public packages found under packages/");

	const failures = packageDirs
		.map((packageDir) => validatePackage(packageDir))
		.filter((result) => result.errors.length > 0);
	if (failures.length === 0) {
		console.log(`Package policy passed for ${packageDirs.length} package(s).`);
		return;
	}
	for (const failure of failures) {
		console.error(`\n${failure.packageName}:`);
		for (const error of failure.errors) console.error(`  - ${error}`);
	}
	process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
