## 2025-02-14 - Prevent XSS in UI Notifications
**Vulnerability:** User input passed directly to `ctx.ui.notify` without sanitization.
**Learning:** Functions that render strings in the UI like `ctx.ui.notify` can be exploited for XSS if unescaped string arguments are provided.
**Prevention:** All user input passed to UI rendering functions must be HTML-escaped using a function like `escapeHtml`.
