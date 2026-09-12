## 2026-09-12 - [XSS Vulnerability in CLI Arguments]
**Vulnerability:** [Unescaped user input passed to UI notifications]
**Learning:** [User input from command arguments can be reflected back in the UI, leading to XSS if not escaped]
**Prevention:** [Always escape user input using escapeHtml before passing it to ctx.ui.notify]
