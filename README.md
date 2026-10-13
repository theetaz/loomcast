<p align="center"><img src="design/brand/loomcast-mark.svg" width="72" alt="Loomcast"></p>

<h1 align="center">Loomcast</h1>

<p align="center">Weave ideas into short videos. Script, render and publish from one place.</p>

## Purpose

Loomcast is a small, invite-only platform for producing short technology videos (reels and shorts). Scripts are drafted and reviewed in a web app. Videos are rendered by a studio running on a local workstation and published to Instagram, Threads and YouTube Shorts on a schedule.

The platform is used by a few people, so there is no public sign-up. Accounts are created by an administrator from the command line or through an MCP tool.

## Architecture

| Component | Role | Hosting |
|---|---|---|
| `web` | React + Vite app built on shadcn/ui with the Loomcast theme | VPS (Docker Compose, nginx, certbot) |
| `api` | Auth, scripts, render queue, scheduler, publisher, MCP endpoint, bridge to the studio | VPS |
| `postgres` | Primary database | VPS |
| Studio | Renders videos with HyperFrames / Remotion and pushes results through the bridge | Local workstation |
| Object storage | Finished videos, served publicly for platform ingestion | Cloudflare R2 |

Production runs at `loomcast.prabhavalabs.com`. Locally, the same stack runs with Docker Compose, and SeaweedFS stands in for Cloudflare R2.

## Repository layout

| Path | Contents |
|---|---|
| `design/brand/` | Brand kit: logo mark and glyph, colour tokens, type, motion rules, and an interactive preview (`loomcast-brand.html`) |
| `studio/` | Video studio workspace: render helper scripts, a style library of motion-graphic reference cards, and style templates |
| `apps/api` | API: auth, scripts, render queue, scheduler, publisher, MCP endpoint and bridge to the studio |
| `apps/web` | React and Vite web app built on shadcn/ui with the Loomcast theme |
| `apps/studio-agent` | Local producer agent that drives the studio and pushes renders through the bridge |
| `packages/*` | Shared packages used by the apps |
| `tests/e2e` | End-to-end tests |

## Not versioned

- Rendered video and audio, studio project folders, local databases and backups.
- Secrets: `.env` files, keys and credentials. Each component ships a `.env.example` instead.
- Configuration and instruction files for AI coding agents and editor assistants. These stay local and are listed in `.gitignore`.

## Getting started

Requirements: Node.js 22+ (`.node-version` pins 24), pnpm (the version is pinned in `package.json`), Docker, ffmpeg and Chrome/Chromium for rendering.

```bash
git clone git@github.com:theetaz/loomcast.git
cd loomcast
pnpm install
cp .env.example .env                 # placeholders; fill only the keys you need
cp studio/.env.example studio/.env   # fill only the keys you need
pnpm stack:up                        # local Postgres and object storage in Docker
pnpm db:migrate
pnpm admin:create --email you@example.com --name "Your Name" --role owner
pnpm dev                             # API on :8790, web app on http://localhost:5173
```

Other root scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` and `pnpm stack:down`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list of checks, and the [local development guide](docs/local-development.md) for pairing a studio agent, connecting an MCP client and troubleshooting.

Open `design/brand/loomcast-brand.html` in a browser to see the theme and components.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Components, decisions, data model, live events and the security model |
| [Local development](docs/local-development.md) | Setup, ports, admin CLI, pairing a studio agent, MCP clients, tests, the M1 acceptance runbook and troubleshooting |
| [Bridge protocol](docs/bridge-protocol.md) | Pairing, the `/bridge/v1` WebSocket protocol, the job lifecycle and its reliability rules |
| [MCP server](docs/mcp.md) | Endpoint, authentication, client configuration and the tool reference |

Each app and package also has a README: [`apps/api`](apps/api/README.md), [`apps/web`](apps/web/README.md), [`apps/studio-agent`](apps/studio-agent/README.md), [`packages/contracts`](packages/contracts/README.md), [`packages/db`](packages/db/README.md) and [`packages/ui`](packages/ui/README.md).

## Contributing

Branching, commit and pull-request conventions are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licences

`studio/` includes material from the [HyperFrames student kit](https://github.com/nateherkai/hyperframes-student-kit) (MIT) and references [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0). Their licence and notice files are kept in `studio/LICENSE.hyperframes-student-kit`, `studio/licenses/` and `studio/THIRD_PARTY_NOTICES.md`.
