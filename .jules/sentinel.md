## 2024-05-24 - [HIGH] XSS Vulnerability in Extension Notifications
**Vulnerability:** The `pi-hello` extension passed unescaped user input directly into the `ctx.ui.notify()` function.
**Learning:** Even internal tool extensions and APIs where you might trust the user can be vectors for XSS if user input is reflected without sanitization. The UI notify function renders input as HTML.
**Prevention:** All user input passed to UI rendering functions (like `ctx.ui.notify`) must be HTML-escaped (`&`, `<`, `>`, `"`, `'`) before being displayed.
