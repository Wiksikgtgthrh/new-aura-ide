---
name: code-review
description: Structured code review for correctness, security, maintainability and regressions.
---

# Code Review

Use this skill for every non-trivial change before declaring completion.

## Review order

1. Read the diff and affected callers before judging individual lines.
2. Check behavior and edge cases: null/empty/error/loading states, retries, concurrency and backwards compatibility.
3. Check security: input validation, authorization boundaries, secret exposure, shell injection, SSRF, unsafe file paths and dependency risk.
4. Check types, tests, lint, formatting and error handling.
5. Check performance: unnecessary requests, N+1 work, blocking operations, bundle impact and missing cleanup.
6. For UI, check semantic HTML, keyboard access, focus-visible, contrast, responsive layout and real browser behavior.

## Output

Return findings ordered by severity: blocker, high, medium, low. Each finding includes file/line, why it matters, and a concrete fix. If there are no findings, say what was checked and list residual risks. Do not rewrite code silently during review; implementation belongs to the builder unless the orchestrator explicitly assigns a fix.

## Evidence

Prefer tests, type checks, lint output, browser snapshots and reproducible commands over intuition. Never claim a check ran if it did not.

## Safety

Never print secrets or copy credentials into reports. For infrastructure changes, review the command plan before execution and require explicit approval for destructive actions.
