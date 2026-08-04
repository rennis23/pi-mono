import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 🛡️ Sentinel: Sanitize user input to prevent Cross-Site Scripting (XSS)
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
			let target = args.trim() || "world";

			// 🛡️ Sentinel: Prevent UI DoS via unbounded input length
			if (target.length > 100) {
				target = `${target.substring(0, 100)}...`;
			}

			// 🛡️ Sentinel: Sanitize input before rendering in UI notification
			target = escapeHtml(target);

			ctx.ui.notify(`Hello, ${target}!`, "info");
		},
	});
}
