---
name: issue-review
description: Investigate, review, and fix GitHub issues. Use when a request references a GitHub issue URL or number and asks for analysis, root-cause location, implementation, or a fix commit.
---

# Issue Review

1. Begin with `gh issue view <number-or-url> --comments` (add `--repo owner/repo` when needed). Read the actual issue before locating the cause in the repository.
2. If implementing the fix, validate it and create one scoped commit whose message or footer contains `Closes #<number>` or `Fixes #<number>`.
3. Before finishing, verify the committed file scope and the closing keyword with `git show --stat --format=fuller HEAD`.
4. After the fix, draft and, when authorized, post a short issue reply saying it is fixed and will be available in the next version. Verify the issue is closed; if needed, close it with `gh issue close`.
