import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Security enhancement: Prevent XSS by escaping HTML in user input
function escapeHtml(str: string) {
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
			// 🛡️ Sentinel: Sanitize user input to prevent XSS in ui.notify
			const sanitizedTarget = escapeHtml(target);
			ctx.ui.notify(`Hello, ${sanitizedTarget}!`, "info");
		},
	});
}
