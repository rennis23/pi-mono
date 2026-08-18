import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Security: Escape HTML to prevent XSS in UI notifications
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
			const rawTarget = args.trim() || "world";
			const target = escapeHtml(rawTarget);
			ctx.ui.notify(`Hello, ${target}!`, "info");
		},
	});
}
