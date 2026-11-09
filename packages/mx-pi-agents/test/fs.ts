import type { Stats } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/**
 * Read a file's contents and metadata through a single descriptor.
 *
 * Calling `statSync(path)` and then `readFileSync(path)` is a TOCTOU pattern
 * (CodeQL `js/file-system-race`): the path can be replaced between the two
 * calls. Tests that need both the mode and the content use this helper so the
 * stat and the read always observe the same file.
 */
export function readFileWithStat(path: string): { content: string; stats: Stats } {
	const fd = openSync(path, "r");
	try {
		const stats = fstatSync(fd);
		const content = readFileSync(fd, "utf8");
		return { content, stats };
	} finally {
		closeSync(fd);
	}
}
