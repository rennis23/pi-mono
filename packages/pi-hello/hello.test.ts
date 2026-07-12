import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import helloExtension from "./index.js";

function setupMock() {
	const captured = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const notify = vi.fn();
	const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			captured.set(name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, ctx, notify, captured };
}

describe("pi-hello", () => {
	it("registers the /hello command", () => {
		const registerCommand = vi.fn();
		const pi = { registerCommand } as unknown as ExtensionAPI;

		helloExtension(pi);

		expect(registerCommand).toHaveBeenCalledTimes(1);
		expect(registerCommand).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({
				description: "Say hello from pi-hello",
				handler: expect.any(Function),
			}),
		);
	});

	it("notifies with a greeting when invoked without args", async () => {
		const { pi, ctx, notify, captured } = setupMock();

		helloExtension(pi);
		const def = captured.get("hello");
		expect(def).toBeDefined();
		await def!.handler("", ctx);

		expect(notify).toHaveBeenCalledWith("Hello, world!", "info");
	});

	it("uses the provided argument as the greeting target", async () => {
		const { pi, ctx, notify, captured } = setupMock();

		helloExtension(pi);
		const def = captured.get("hello");
		expect(def).toBeDefined();
		await def!.handler("pi", ctx);

		expect(notify).toHaveBeenCalledWith("Hello, pi!", "info");
	});
});
