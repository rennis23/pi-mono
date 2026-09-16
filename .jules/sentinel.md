## 2024-09-16 - Prevent XSS in UI Notifications
**Vulnerability:** User input passed to `ctx.ui.notify` without escaping allows XSS injection.
**Learning:** `pi-coding-agent` UI functions render HTML and require untrusted input to be escaped.
**Prevention:** Always use an `escapeHtml` utility before passing user input to UI functions like `ctx.ui.notify`.
