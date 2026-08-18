## 2025-05-18 - [Fix XSS vulnerability in UI notifications]
**Vulnerability:** The `pi-hello` extension passed unescaped user input directly into `ctx.ui.notify`, allowing for potential Cross-Site Scripting (XSS) if a user passed HTML/JavaScript payloads.
**Learning:** All user inputs passed to UI functions, especially those rendering HTML, must be escaped.
**Prevention:** Implement and use an `escapeHtml` function to sanitize user inputs before passing them to UI rendering or notification functions.