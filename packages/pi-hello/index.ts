import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function escapeHTML(str: string): string {
	return str
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
			const target = args.trim() || "world";
			// Sanitize user input to prevent XSS in UI notifications
			const sanitizedTarget = escapeHTML(target);
			ctx.ui.notify(`Hello, ${sanitizedTarget}!`, "info");
		},
	});
}
