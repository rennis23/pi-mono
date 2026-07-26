import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function sanitizeHtml(text: string): string {
	return text
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
			const sanitizedTarget = sanitizeHtml(target);
			// 🛡️ Sentinel: Sanitize user input before passing it to the UI to prevent XSS.
			ctx.ui.notify(`Hello, ${sanitizedTarget}!`, "info");
		},
	});
}
