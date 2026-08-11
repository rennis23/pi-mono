## 2024-05-18 - XSS Vulnerability in UI Notifications
**Vulnerability:** Cross-Site Scripting (XSS) vulnerability found in `pi-hello` extension where user input was passed directly to `ctx.ui.notify()` without sanitization.
**Learning:** Any user input passed to UI functions like `ctx.ui.notify` within extensions must be HTML-escaped. The notification system processes HTML, meaning unescaped input can lead to XSS execution in the extension UI context.
**Prevention:** Always sanitize/escape user input using HTML escaping before passing it to UI components or notifications.
