#!/usr/bin/env node
/** Print survived and uncovered mutants from the latest Stryker JSON report. */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPORT = "reports/mutation/mutation.json";
const STATUS_SHORT = { Survived: "S", NoCoverage: "N" };

export function readMutationReport(reportPath = DEFAULT_REPORT) {
	try {
		return JSON.parse(readFileSync(reportPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read Stryker report at ${reportPath}: ${error.message}`);
	}
}

function displayPath(file) {
	return relative(process.cwd(), resolve(file)) || file;
}

export function gapRows(report, target) {
	return Object.entries(report.files ?? {})
		.filter(([file]) => !target || file.includes(target))
		.flatMap(([file, data]) => {
			const mutants = (data.mutants ?? [])
				.filter((mutant) => mutant.status === "Survived" || mutant.status === "NoCoverage")
				.sort((left, right) => left.location.start.line - right.location.start.line);
			return mutants.length === 0 ? [] : [{ file: displayPath(file), mutants }];
		});
}

export function formatSummary(report) {
	const rows = Object.entries(report.files ?? [])
		.map(([file, data]) => {
			const mutants = data.mutants ?? [];
			const survived = mutants.filter((mutant) => mutant.status === "Survived").length;
			const noCoverage = mutants.filter((mutant) => mutant.status === "NoCoverage").length;
			const killed = mutants.filter((mutant) => mutant.status === "Killed").length;
			return { file: displayPath(file), killed, survived, noCoverage };
		})
		.filter((row) => row.survived + row.noCoverage > 0)
		.sort((left, right) => right.survived + right.noCoverage - (left.survived + left.noCoverage));

	return [
		"gap  survived  noCov  killed  file",
		...rows.map(
			(row) =>
				`${String(row.survived + row.noCoverage).padStart(4)}  ${String(row.survived).padStart(8)}  ${String(
					row.noCoverage,
				).padStart(5)}  ${String(row.killed).padStart(6)}  ${row.file}`,
		),
	].join("\n");
}

export function formatDetails(report, target) {
	const rows = gapRows(report, target);
	if (rows.length === 0) return `No survivors or uncovered mutants matching "${target}".`;

	return rows
		.map(({ file, mutants }) => {
			const lines = mutants.map((mutant) => {
				const line = String(mutant.location.start.line).padStart(4);
				const replacement = JSON.stringify(mutant.replacement).slice(0, 100);
				return `${STATUS_SHORT[mutant.status] ?? "?"} L${line} ${mutant.mutatorName.padEnd(20)} => ${replacement}`;
			});
			return [`\n### ${file}  (gap ${mutants.length})`, ...lines].join("\n");
		})
		.join("\n");
}

function main() {
	const target = process.argv[2];
	const reportPath = process.argv[3] ?? DEFAULT_REPORT;
	const report = readMutationReport(reportPath);
	console.log(target ? formatDetails(report, target) : formatSummary(report));
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
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
