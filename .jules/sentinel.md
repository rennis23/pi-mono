## 2024-07-26 - Prevent XSS in Agent UI Notifications
**Vulnerability:** The pi-hello extension passed unsanitized user input directly to `ctx.ui.notify`, which could lead to Cross-Site Scripting (XSS).
**Learning:** Agent extensions must treat command arguments as untrusted input.
**Prevention:** Always sanitize or escape input before sending it to UI contexts using string replacement or an equivalent method.
