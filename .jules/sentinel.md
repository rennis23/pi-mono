## 2026-07-30 - Prevent untracked files in automated release commits
**Vulnerability:** The release script automatically staged and committed untracked files via `git ls-files -o` during version tagging.
**Learning:** Automated commit scripts using broad shell patterns or git flags (like `-o` for untracked files) can unintentionally sweep up local developer files, credentials, or build artifacts into the repository history.
**Prevention:** Always scope automated git add/commit commands to explicit files or strictly modified/deleted tracked files (`-m -d`). Avoid catch-all flags in automated workflows.
