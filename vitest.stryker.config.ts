import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			// Source-text tests assert on exact source strings and cannot survive mutation instrumentation.
			exclude: ["scripts/**/*.test.mjs"],
		},
	}),
);
