## 2024-08-27 - [XSS Vulnerability in UI Notify]
**Vulnerability:** Cross-Site Scripting (XSS) via unsanitized user input passed to `ctx.ui.notify` in pi-hello.
**Learning:** Functions that render UI components (like `ctx.ui.notify`) in `@earendil-works/pi-coding-agent` may evaluate HTML. Passing raw user input directly to them enables arbitrary script execution or UI redressing.
**Prevention:** Always HTML-escape user input before passing it to any UI rendering function like `ctx.ui.notify`.
