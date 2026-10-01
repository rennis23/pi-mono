import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

/**
 * Vitest config used only by Stryker (see `stryker.config.json`).
 *
 * Stryker rewrites sandbox sources with coverage and mutant-switching
 * instrumentation. `source-structure.test.ts` reads `index.ts` as text and
 * asserts on exact substrings, which instrumented sources no longer contain,
 * so that file is excluded from mutation runs. It still runs under the normal
 * `vitest.config.ts`.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			// `sandbox/**` is already excluded by the base config; array excludes
			// are concatenated by `mergeConfig`.
			exclude: ["packages/mx-pi-agents/src/source-structure.test.ts"],
		},
	}),
);
