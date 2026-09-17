## 2026-09-17 - XSS in UI Notifications
**Vulnerability:** Untrusted user input (`arg` and `cmd` from `/mx-pi-settings` command) was passed directly to `ctx.ui.notify`, which is vulnerable to HTML injection (XSS) when rendered by the `@earendil-works/pi-coding-agent` UI.
**Learning:** In the pi-coding-agent extension environment, UI notification functions like `ctx.ui.notify` can interpret HTML, making them vulnerable to XSS if user-controlled command arguments are not properly sanitized before display.
**Prevention:** Always use a robust HTML escaping utility function (e.g., `escapeHtml`) on all user-supplied input (like command arguments) before passing it to `ctx.ui.notify` or similar UI display functions, ensuring the utility handles null/undefined values safely.
