## 2024-09-11 - Prevent XSS in UI Notifications
**Vulnerability:** User inputs passed directly to ctx.ui.notify in extension commands were unescaped, allowing potential Cross-Site Scripting (XSS).
**Learning:** Extension frameworks like @earendil-works/pi-coding-agent need HTML-escaped text for UI functions because they are rendered in HTML.
**Prevention:** Always use an escapeHtml function to sanitize user inputs before passing to UI notification functions.
