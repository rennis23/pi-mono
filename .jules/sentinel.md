## 2024-09-10 - [Fix XSS in UI notifications]
**Vulnerability:** User inputs (`arg`, `cmd`) and runtime error messages (`err.message`) were interpolated directly into `ctx.ui.notify` calls without sanitization.
**Learning:** In the Pi extension API (`@earendil-works/pi-coding-agent`), `ctx.ui.notify` strings are rendered as HTML, which means untrusted content injected into these strings creates Cross-Site Scripting (XSS) vulnerabilities.
**Prevention:** Implement and enforce usage of a central HTML escaping utility (`escapeHtml`) that explicitly handles `undefined`/`null` and explicitly casts values to `String` before replacing HTML entities. Any user input or dynamic error message passed to `ctx.ui.notify` must be escaped.
