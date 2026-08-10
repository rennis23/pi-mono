## 2025-02-23 - [XSS] Unsanitized user input in ctx.ui.notify
**Vulnerability:** Found an XSS vulnerability in `packages/pi-hello/index.ts` where the user input (`args`) in the extension's command handler is passed directly to the `ctx.ui.notify` UI function without any HTML sanitization.
**Learning:** When developing extensions using `@earendil-works/pi-coding-agent`, it's critical to realize that strings passed to UI functions (like notifications) might be rendered in an HTML context within the editor. Passing arbitrary user input can lead to XSS.
**Prevention:** Always HTML-escape user input (`&`, `<`, `>`, `"`, `'`) before passing it to `ctx.ui.notify` or any other UI-rendering function to ensure that potentially malicious payloads are displayed as safe text instead of being executed.
