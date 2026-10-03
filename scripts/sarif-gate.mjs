#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseSarif(content) {
	let report;
	try {
		report = JSON.parse(content);
	} catch (error) {
		throw new Error(`cannot parse SARIF: ${error.message}`);
	}
	if (!report || !Array.isArray(report.runs)) throw new Error("SARIF must contain a runs array");
	return report;
}

export function sarifFindings(report) {
	return report.runs.flatMap((run) => (Array.isArray(run.results) ? run.results : []));
}

function findingLocation(finding) {
	const location = finding.locations?.[0]?.physicalLocation;
	const uri = location?.artifactLocation?.uri ?? "unknown file";
	const line = location?.region?.startLine;
	return line === undefined ? uri : `${uri}:${line}`;
}

export function assertCleanSarif(report) {
	const findings = sarifFindings(report);
	if (findings.length === 0) return;
	const details = findings.map((finding) => {
		const rule = finding.ruleId ?? "unknown rule";
		const message = finding.message?.text ?? "no message";
		return `${rule} at ${findingLocation(finding)}: ${message}`;
	});
	throw new Error(
		`CodeQL found ${findings.length} finding(s):\n${details.map((detail) => `  - ${detail}`).join("\n")}`,
	);
}

export function checkSarifFile(filePath) {
	const path = resolve(filePath);
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`cannot read SARIF file ${path}: ${error.message}`);
	}
	const report = parseSarif(content);
	assertCleanSarif(report);
	return report;
}

function isMainModule() {
	try {
		return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	try {
		checkSarifFile(process.argv[2] ?? ".codeql/results.sarif");
		console.log("SARIF gate passed: no findings.");
	} catch (error) {
		console.error(`SARIF gate failed: ${error.message}`);
		process.exitCode = 1;
	}
}
