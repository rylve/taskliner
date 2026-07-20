# Contributing

Thanks for your interest in Taskliner.

## What is welcome

- Bug reports with clear reproduction steps
- Concrete, actionable feedback about the official app at [taskliner.app](https://taskliner.app)
- Small focused fixes when they help (typos, docs, narrow bug fixes, useful tests)

## How this project is developed

Taskliner is primarily developed by the maintainer alone.

Replies, bug fixes, feature work, and pull request review are **not guaranteed**. Issues and PRs may stay open, be deferred, or be closed without merging.

## Pull requests

- Open an Issue **before** implementing large changes. Discuss scope first.
- Keep changes small and focused.
- Large PRs submitted without prior Issue discussion may be closed without detailed review.
- Bulk auto-generated or AI-generated PR floods are not accepted.
- UX, product design, and roadmap decisions remain with the maintainer.

## Security

Do not report security issues in public Issues. See [SECURITY.md](./SECURITY.md).

## What not to include

Do not paste any of the following into Issues or pull requests:

- Real task titles, notes, or other personal content
- JSON exports of real user data
- Discord Webhook URLs
- Tokens, cookies, private keys, or other secrets
- Screenshots that show private task content

## Local checks

Before opening a PR when you can:

```bash
node --test tests/*.test.mjs
node --check app.js
git diff --check
```
