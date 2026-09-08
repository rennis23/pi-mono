## 2024-05-18 - XSS in Extension Command Handler
**Vulnerability:** Cross-Site Scripting (XSS) vulnerability found in extension command handlers where user-provided input (`cmd` and `arg` parameters) was directly interpolated into `ctx.ui.notify` without HTML escaping.
**Learning:** `pi-coding-agent` UI notification functions like `ctx.ui.notify` can render unescaped content. In extension development, commands can receive arbitrary user input which can act as a vector for XSS if those arguments are displayed in error or info messages.
**Prevention:** Always sanitize and HTML-escape user input before passing it to any UI functions that render HTML, especially when logging unknown commands or invalid arguments back to the user.
