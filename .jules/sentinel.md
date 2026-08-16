## 2024-08-16 - Prevent XSS in pi-coding-agent Extension Notifications
**Vulnerability:** User input passed to `ctx.ui.notify` in `@earendil-works/pi-coding-agent` extensions could result in Cross-Site Scripting (XSS) if not properly escaped.
**Learning:** `ctx.ui.notify` likely renders HTML directly in the UI. Extensions must not pass raw user input (like command arguments) directly to UI functions without escaping.
**Prevention:** Always escape HTML entities (e.g., `<`, `>`, `&`, `"`, `'`) in user input before passing it to any `ctx.ui.*` functions to prevent script injection.
