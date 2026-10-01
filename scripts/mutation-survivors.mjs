#!/usr/bin/env node
/**
 * Print the survived / no-coverage mutants from the latest Stryker JSON report.
 *
 * Usage:
 *   node scripts/mutation-survivors.mjs [file-substring] [report-path]
 *
 * With no arguments it prints a per-file gap summary. With a substring it
 * prints one line per mutant in every matching file, so tests can be written
 * against specific lines.
 */
import { readFileSync } from "node:fs";

const target = process.argv[2];
const reportPath = process.argv[3] ?? "reports/mutation/mutation.json";

let report;
try {
	report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
	console.error(`Cannot read Stryker report at ${reportPath}: ${error.message}`);
	console.error("Run `npm run mutation` first.");
	process.exit(1);
}

const STATUS_SHORT = { Survived: "S", NoCoverage: "N" };
const statusLabel = (status) => STATUS_SHORT[status] ?? "?";

if (!target) {
	const rows = [];
	for (const [file, data] of Object.entries(report.files)) {
		const survived = data.mutants.filter((m) => m.status === "Survived").length;
		const noCoverage = data.mutants.filter((m) => m.status === "NoCoverage").length;
		const killed = data.mutants.filter((m) => m.status === "Killed").length;
		if (survived + noCoverage > 0) {
			rows.push({ file: file.replace("packages/mx-pi-agents/", ""), killed, survived, noCoverage });
		}
	}
	rows.sort((a, b) => b.survived + b.noCoverage - (a.survived + a.noCoverage));
	console.log("gap  survived  noCov  killed  file");
	for (const row of rows) {
		console.log(
			`${String(row.survived + row.noCoverage).padStart(4)}  ${String(row.survived).padStart(8)}  ${String(
				row.noCoverage,
			).padStart(5)}  ${String(row.killed).padStart(6)}  ${row.file}`,
		);
	}
	process.exit(0);
}

let printed = false;
for (const [file, data] of Object.entries(report.files)) {
	if (!file.includes(target)) continue;
	const rows = data.mutants
		.filter((m) => m.status === "Survived" || m.status === "NoCoverage")
		.sort((a, b) => a.location.start.line - b.location.start.line);
	if (rows.length === 0) continue;
	printed = true;
	console.log(`\n### ${file.replace("packages/mx-pi-agents/", "")}  (gap ${rows.length})`);
	for (const m of rows) {
		const line = String(m.location.start.line).padStart(4);
		const replacement = JSON.stringify(m.replacement).slice(0, 100);
		console.log(`${statusLabel(m.status)} L${line} ${m.mutatorName.padEnd(20)} => ${replacement}`);
	}
}
if (!printed) console.log(`No survivors or uncovered mutants matching "${target}".`);
