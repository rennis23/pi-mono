import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Say hello from pi-hello",
		handler: async (args, ctx) => {
			const target = args.trim() || "world";

			// SECURITY ENHANCEMENT: Input length validation to prevent potential DoS or formatting issues
			if (target.length > 50) {
				ctx.ui.notify("Input exceeds maximum length of 50 characters", "error");
				return;
			}

			ctx.ui.notify(`Hello, ${target}!`, "info");
		},
	});
}
