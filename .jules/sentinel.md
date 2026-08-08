## 2025-05-18 - Fix XSS in UI notifications
**Vulnerability:** Unsanitized user input was passed directly to the `ctx.ui.notify` function in the `hello` command. If user input contained HTML characters (e.g. `<script>`), it could be rendered by the UI, leading to Cross-Site Scripting (XSS).
**Learning:** `ctx.ui.notify` does not automatically sanitize HTML input, meaning extensions must manually escape untrusted data before passing it to the UI.
**Prevention:** Always use an HTML escaping function (like `escapeHtml`) on untrusted data before passing it to `ctx.ui.notify` or any other UI rendering function.
