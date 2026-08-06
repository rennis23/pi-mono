## 2024-05-15 - [XSS] Unescaped user input in UI notifications
**Vulnerability:** User input passed to the `/hello` command was directly injected into `ctx.ui.notify` without HTML escaping, creating a Cross-Site Scripting (XSS) vulnerability.
**Learning:** The `@earendil-works/pi-coding-agent` API does not automatically sanitize inputs before rendering them in the UI. We must manually escape all user inputs passed to UI functions like `ctx.ui.notify`.
**Prevention:** Always escape HTML entities (`&`, `<`, `>`, `"`, `'`) for any variable interpolated into strings that will be displayed in the UI, or use a dedicated sanitization library.
