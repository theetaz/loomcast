# Contributing

This document defines how changes are proposed, written and merged in this repository. It applies to every contributor.

## 1. Branching model

| Branch | Purpose | Created from | Merges into |
|---|---|---|---|
| `main` | Always releasable. Never committed to directly after the initial commit. | n/a | n/a |
| `feature/<short-description>` | New capability, documentation or refactoring | `main` | `main` via pull request |
| `bugfix/<short-description>` | Fix for a defect | `main` | `main` via pull request |

Naming rules:
- Lowercase kebab case, for example `feature/script-editor` or `bugfix/publish-retry`.
- If an issue exists, put its number first: `feature/42-render-queue`.
- Keep branches short-lived. Rebase on `main` before opening or updating a pull request.

## 2. Commit messages

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<optional scope>): <subject>

<body>

<footer>
```

**Types**

| Type | Use for |
|---|---|
| `feat` | A new capability |
| `fix` | A defect fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a defect nor adds a capability |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests |
| `build` | Dependencies, packaging, build tooling |
| `ci` | Continuous-integration configuration |
| `chore` | Maintenance that does not change behaviour |
| `revert` | Reverting an earlier commit |

**Scopes** in this repository: `web`, `api`, `ui`, `bridge`, `studio`, `brand`, `infra`, `deps`, `docs`, `repo`.

**Subject line**
- Imperative mood ("add", not "added" or "adds").
- Lowercase, no trailing full stop, at most 72 characters.

**Body**
- Explains *what* changed and *why*, not how.
- Wrapped at 72 characters.
- Uses bullet points for lists of changes.

**Footer**
- References issues (`Refs: #42`, `Closes: #42`).
- Declares breaking changes (`BREAKING CHANGE: <description>`).

**Authorship**
- A commit is authored solely by the person who makes it.
- Commit messages contain no co-author trailers and no references to the tools used to produce the change.

Example:

```
feat(api): schedule approved scripts for publishing

Scripts approved in the web app now enter a publish queue with a
target time per channel, so Instagram and Threads posts go out without
manual action.

- add a publish_jobs table with channel, run_at and status
- run a scheduler that claims due jobs and calls the channel client
- retry failed jobs with backoff and record the last error

Refs: #12
```

## 3. Pull requests

- Each pull request covers one logical change and targets `main`.
- The title follows the commit-message format, for example `feat(web): add script editor`. It becomes the squash-commit subject.
- The description uses the repository template (`.github/pull_request_template.md`):
  - summary;
  - changes;
  - motivation;
  - testing performed;
  - risks and rollback.
- Descriptions are written in a formal, factual tone. They describe the change and its evidence, not how it was produced.
- Every pull request is reviewed before merge. It is merged with **squash and merge**, and the branch is then deleted.

## 4. What is never committed

- Data of any kind: local databases, backups, rendered videos and audio, model weights.
- Secrets and local configuration: `.env*`, keys, credentials.
- Configuration and instruction files for AI agents and editor assistants, for example `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.cursor/`, `.github/copilot-instructions.md`. The full list is in `.gitignore`.
- Studio output (`studio/video-projects/`, `studio/renders/`).

## 5. Before opening a pull request

```bash
pnpm install
pnpm -r lint
pnpm -r test
git status --porcelain   # nothing unintended staged
```
