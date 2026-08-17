## 2026-08-17 - Prevent XSS in Extension UI Notifications
**Vulnerability:** User input was passed directly into `ctx.ui.notify()` in the pi-hello extension without escaping, which could lead to Cross-Site Scripting (XSS) if the notification content is rendered as HTML.
**Learning:** `ctx.ui.notify()` and similar UI API functions in `@earendil-works/pi-coding-agent` may render HTML, and failing to sanitize extension command arguments before presenting them in UI notifications creates an XSS vulnerability vector.
**Prevention:** Always escape HTML characters (like `<`, `>`, `&`, `"`, `'`) from user input when passing it to UI rendering functions like `ctx.ui.notify()`.
