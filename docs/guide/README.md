# Loomcast guide

The guide explains how to use Loomcast, keep the studio agent running and fix things when they
break. The web app shows the same pages under **Guide** in the sidebar, after you sign in.

Loomcast is organised by workspace: one workspace per brand, each with its own channels, calendar,
library, review queue, analytics, chat, knowledge base, series and research. Start with
[Getting started](getting-started.md), then [Workspaces and the producer chat](workspaces.md).

## Using Loomcast

- [Getting started](getting-started.md)
- [Workspaces and the producer chat](workspaces.md)
- [Series and formats](series-and-formats.md)
- [Videos, review and approvals](videos-and-review.md)
- [Knowledge base](knowledge-base.md)
- [Competitor research](competitor-research.md)
- [Channels, calendar and publishing](publishing.md)
- [Settings](settings.md)
- [API clients](api-clients.md)

## Studio agent

- [Setting up the studio agent](studio-agent.md)
- [Troubleshooting](troubleshooting.md)

## Running Loomcast

- [Deploying and running the server](operations.md)

## Writing guide pages

- Each page is `<slug>.md` in this folder and starts with `# <Title>`. The app lists the pages in
  `apps/web/src/features/guide/pages.ts`; a new page needs an entry there.
- Screenshots live in `images/`. They are taken in mock mode, where the API is simulated with
  made-up demo data, so they never show a real account. Retake them after a screen changes:

  ```bash
  pnpm --filter @loomcast/e2e guide:screenshots           # every screenshot
  pnpm --filter @loomcast/e2e guide:screenshots devices   # names containing "devices"
  ```

  New screenshots are added to the list in `tests/e2e/guide/screenshots.ts`.
- The repository is public. Never put addresses, email addresses, account names, ids, tokens or
  local paths in a page; use placeholders such as `<code>` or `https://loomcast.example.com`. A
  test (`apps/web/test/guide.test.tsx`) rejects the common cases, but read every diff anyway.
