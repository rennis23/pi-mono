## 2024-08-23 - XSS Vulnerability in Extension User Input Rendering
**Vulnerability:** Cross-Site Scripting (XSS) in `ctx.ui.notify` due to direct rendering of user input (`args`).
**Learning:** User input from extension command arguments can contain executable scripts if rendered directly by UI elements like notifications. It should never be trusted or rendered as raw HTML.
**Prevention:** Always sanitize or HTML-escape user input before passing it to UI rendering functions (like `ctx.ui.notify`).
