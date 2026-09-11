# Contributing

Thanks for your interest in Taskliner.

This repository is a public reference snapshot, not an actively maintained mirror of the hosted service. The official website is developed separately in a private repository. No ongoing source updates or pull request reviews are promised. You may fork and adapt this snapshot under its MIT License.

## What is welcome

- Bug reports with clear reproduction steps
- Reports that clearly identify the snapshot commit they concern
- Small focused fixes when they help (typos, docs, narrow bug fixes, useful tests)

## How this project is developed

Taskliner is primarily developed by the maintainer alone.

Replies, bug fixes, feature work, and pull request review are **not guaranteed**. Issues and PRs may stay open, be deferred, or be closed without merging.

## Pull requests

- Do not assume that a proposed change will be reviewed or incorporated into the hosted service. Contact the maintainer before investing in a contribution.
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
