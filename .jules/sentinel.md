## 2024-10-24 - Fix XSS Vulnerability in UI Notifications

**Vulnerability:** Cross-Site Scripting (XSS) vulnerability was found in `packages/pi-hello/index.ts` where unescaped user input was directly passed to `ctx.ui.notify`. Since this function renders HTML, an attacker could potentially execute malicious scripts.

**Learning:** When developing extensions using `@earendil-works/pi-coding-agent`, it is crucial to ensure that any user input passed to UI functions like `ctx.ui.notify` is HTML-escaped to prevent XSS vulnerabilities, as the framework currently expects extensions to handle their own HTML sanitization.

**Prevention:** Always use a helper function to escape HTML special characters (`&`, `<`, `>`, `"`, `'`) before interpolating user input into strings that will be displayed in the UI.
