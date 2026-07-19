import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Say hello from pi-hello",
		handler: async (args, ctx) => {
			const target = args.trim() || "world";
			ctx.ui.notify(`Hello, ${target}!`, "info");
		},
	});
}
