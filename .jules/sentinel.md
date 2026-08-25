## 2025-01-20 - [HIGH] Fix XSS vulnerability in UI notifications
**Vulnerability:** The pi-hello extension passed unsanitized user input directly to `ctx.ui.notify()`. This could allow Cross-Site Scripting (XSS) if the input contained malicious HTML/JavaScript and was rendered in the UI.
**Learning:** `ctx.ui.notify()` in `@earendil-works/pi-coding-agent` extensions does not auto-escape HTML. Extensions must sanitize/escape any user input before passing it to UI functions.
**Prevention:** Always use an HTML escaping function (like the added `escapeHtml`) to sanitize any dynamic input or arguments before rendering them via UI functions like `ctx.ui.notify()`.
