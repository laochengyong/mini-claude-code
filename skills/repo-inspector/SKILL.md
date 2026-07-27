---
name: repo-inspector
description: Inspect an unfamiliar repository — map structure, find entry points, summarize what it does.
---

# Repo Inspector

When asked to inspect or understand a repository, work in this order:

1. List the top-level layout with `glob` (`*` and `*/`).
2. Read the README and any package manifest (package.json, pyproject.toml, go.mod, Cargo.toml).
3. Identify the entry point file and read its first 60 lines.
4. Summarize: what the project is, how it's run, where the main logic lives.

Keep the summary short. Prefer reading files over running shell commands.
