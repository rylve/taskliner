# Security Policy

## Reporting a vulnerability

**Do not** open a public GitHub Issue for security vulnerabilities.

Preferred options:

1. **GitHub Private Vulnerability Reporting** on this repository (enable it in repository settings if it is not already on)
2. Email **bloomlateral@gmail.com** with a short description of the issue and how to reproduce it

Please do **not** include:

- Real task titles, notes, or other personal content
- JSON exports of real user data
- Discord Webhook URLs
- Tokens, cookies, private keys, or other secrets

## Scope

In scope for reports against the **official latest version** at [taskliner.app](https://taskliner.app) and the matching source in this repository:

- Exposure of task content, Workspace Data Keys, recovery material, or Discord Webhook URLs outside intended boundaries
- Authentication / OAuth / session handling flaws in the official sync path
- Server-side handling that stores or logs protected content in Taskliner’s own D1/KV contrary to the documented model

Out of scope examples:

- Compromised browser profiles, malware, or device OS compromise
- XSS after the attacker already controls the unlocked browser context as a general class of endpoint risk (still useful to report concrete app bugs)
- Screen capture, keylogging, or shoulder surfing
- Self-hosted deployments that diverge from this repository
- Denial of service against Cloudflare, Google, or Discord infrastructure
- Social engineering against individual users

## Expectations

- First response time and fix timelines are **not guaranteed**
- Reports against outdated forks or heavily modified self-hosted instances may be declined
- This codebase’s cryptography and sync design are documented for transparency; they are **not** a formal security audit or a guarantee of absolute safety

## Additional reading

- [docs/security-model.md](./docs/security-model.md)
- [docs/architecture.md](./docs/architecture.md)
