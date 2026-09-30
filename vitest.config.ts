import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
		// Keep tests hermetic: a child `createAgentSession` builds its own
		// `ModelRuntime`, and without this it refreshes the remote model catalog
		// (a network call that times out at 20s on a cold, offline runner).
		env: { PI_OFFLINE: "1" },
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["packages/*/**/*.ts"],
			exclude: ["**/node_modules/**", "**/.pi/**", "**/dist/**", "**/*.test.ts", "**/*.d.ts", "packages/*/test/**"],
		},
	},
});
