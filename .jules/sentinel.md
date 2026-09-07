## 2024-03-24 - [Fix XSS vulnerability in UI notifications]
**Vulnerability:** User input passed directly to `ctx.ui.notify` without HTML sanitization.
**Learning:** `ctx.ui.notify` might render content in a way that is vulnerable to XSS if not properly escaped. The UI functions from `@earendil-works/pi-coding-agent` require explicit HTML escaping to prevent XSS vulnerabilities, this wasn't implemented for arbitrary inputs passed through commands and errors.
**Prevention:** Use an HTML escaping utility function (like `escapeHtml`) to sanitize any user-controlled input or error message before passing it to UI rendering functions such as `ctx.ui.notify`.
