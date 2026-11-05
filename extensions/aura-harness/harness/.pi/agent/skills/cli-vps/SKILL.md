---
name: cli-vps
description: Safe universal CLI and SSH/VPS operations with discovery, approvals, backups and rollback.
---

# CLI and VPS

Use for shell work, deployment, server maintenance and SSH.

## Local CLI

- Detect the project and package manager before running commands.
- Prefer read-only discovery first: status, version, config and available scripts.
- Run the narrowest validation before broad builds.
- Never invent flags or assume a framework.

## SSH/VPS

- Connect only through an existing host alias in `~/.ssh/config` and an SSH key.
- Never use, store or echo passwords from chat. Never put credentials in commands, logs or files.
- Before mutation: identify the target, show the command plan, check disk/service status and create a backup or rollback point where feasible.
- Execute one reversible step at a time and verify after each step.
- Destructive commands, migrations, firewall changes, deploys and data deletion require explicit user approval.
- Redact tokens, private keys, cookies and connection strings from output.

## Handoff

Report exact commands run, verification evidence, changed files/services and rollback instructions. If access is unavailable, stop after diagnosis instead of guessing.
