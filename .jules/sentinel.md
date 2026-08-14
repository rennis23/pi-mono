## 2023-10-24 - [HIGH] Fix XSS vulnerability in UI notification

**Vulnerability:**
The `hello` command in `packages/pi-hello/index.ts` accepted unescaped user input and passed it directly to `ctx.ui.notify`. In environments where `ctx.ui.notify` renders its argument as HTML, this creates a Cross-Site Scripting (XSS) vulnerability.

**Learning:**
Any user input passed into UI functions like `ctx.ui.notify` needs to be treated as potentially unsafe and HTML-escaped before presentation, since UI layers may attempt to parse it.

**Prevention:**
Enforce an `escapeHTML` helper or similar sanitization on all user input bound for UI functions, unless the UI function is explicitly known to automatically escape input.
