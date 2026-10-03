import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

/**
 * Vitest config used only by Stryker (see `stryker.config.json`).
 *
 * Stryker rewrites sandbox sources with coverage and mutant-switching
 * instrumentation, which breaks tests that assert on exact source strings or on
 * script source text. Those tests still run under the normal `vitest.config.ts`.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			exclude: [
				// Source-text tests assert on exact source strings and cannot survive mutation instrumentation.
				"scripts/**/*.test.mjs",
				"packages/mx-pi-agents/src/source-structure.test.ts",
			],
		},
	}),
);
