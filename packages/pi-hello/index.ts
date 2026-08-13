import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

export default function helloExtension(pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Say hello from pi-hello",
		handler: async (args, ctx) => {
			// Security: Prevent XSS by escaping user input passed to UI functions
			const target = escapeHtml(args.trim() || "world");
			ctx.ui.notify(`Hello, ${target}!`, "info");
		},
	});
}
