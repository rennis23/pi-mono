## 2024-05-27 - Unescaped UI Notifications in Extensions
**Vulnerability:** The pi-hello extension directly interpolates user input (`args`) into UI notifications (`ctx.ui.notify`) without HTML escaping. This could allow for Cross-Site Scripting (XSS) if the UI renders the notification as HTML.
**Learning:** When developing extensions using `@earendil-works/pi-coding-agent`, ensure any user input passed to UI functions like `ctx.ui.notify` is properly HTML-escaped. Even seemingly safe inputs (like names) can contain malicious payloads.
**Prevention:** Implement and enforce a standard HTML escaping utility across all extensions, or ideally, ensure the `ctx.ui.notify` API itself handles escaping safely to prevent this class of vulnerabilities.
