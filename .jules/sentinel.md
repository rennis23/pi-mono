## 2024-05-14 - Prevent data leakage during automated releases

**Vulnerability:** The release script (`scripts/release.mjs`) used `git ls-files -o` to stage untracked files automatically during release preparation. This creates a data leakage risk, as local uncommitted files like `.env`, secrets, internal notes, or test data could be accidentally pushed to a public repository if they are not explicitly listed in `.gitignore`.

**Learning:** Automated tools that indiscriminately include files without explicit user review can inadvertently bypass security controls like `.gitignore` (if a file hasn't been added yet) or explicit staging practices.

**Prevention:** Never use blanket "include untracked" commands in automated commit/release scripts. Use `git ls-files -m -d` to only stage modified or deleted known tracked files, or explicitly specify the allowed paths to stage (e.g., `git add packages/*/package.json`).