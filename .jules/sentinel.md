## 2026-08-24 - [Fix XSS in pi-hello extension]
**Vulnerability:** Cross-Site Scripting (XSS) vulnerability in `packages/pi-hello/index.ts` where unescaped user input was passed to `ctx.ui.notify`.
**Learning:** Extension commands receiving user input and passing it to UI functions like `ctx.ui.notify` without sanitization creates XSS risks, especially in environments interpreting HTML/Markdown.
**Prevention:** Always escape HTML entities (`&`, `<`, `>`, `"`, `'`) before passing user-controlled input to any UI rendering function.
