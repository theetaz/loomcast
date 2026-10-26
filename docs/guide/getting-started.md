# Getting started

Loomcast helps you plan, produce, review and publish short vertical videos for Instagram, Facebook and Threads. This page explains how the pieces fit together, takes you round the screen, and lists what to set up on your first day: a workspace for your brand and its channels.

## What Loomcast is

Loomcast is a control plane. It has two halves:

- **The web app** is where you plan, review, schedule and publish. It is organised by workspace: one workspace per brand, each with its own channels, calendar, library, review queue, analytics, knowledge base, series and research.
- **The studio agent** is a small program that runs on a paired Mac. It does the producing: it researches and chats with you through the producer session, writes scripts, cuts storyboards, records the voice with the voice provider (ElevenLabs) and renders the final MP4.

Nothing heavy runs on the server. The server keeps the records, hands work to the studio agent as jobs, stores the finished media and sends posts to the platforms at their slots. When the studio agent is offline, work waits in a queue and starts as soon as it reconnects.

| Who does it | What |
|---|---|
| You, in the web app | Create workspaces and connect their channels, create series and set format rules, add ideas and knowledge, review and approve videos, move posts on the calendar |
| The studio agent on the Mac | Chat replies, scripts, storyboards, revisions, voice takes, renders, competitor analyses |
| The server | Plans the cadence, queues jobs, approves automatically where the rules allow, publishes at the slot |

## Signing in

Loomcast is invite only. There is no sign-up page: the owner creates your account and sends you a link.

![The sign-in page, with Email and Password fields and a Sign in button](images/login.png)

1. Open your Loomcast address, for example `https://loomcast.example.com`.
2. Enter your **Email** and **Password**.
3. Press **Sign in**.

If you see "That email and password don't match", check both and try again. If you have forgotten your password, ask the owner for a new password link.

### Setting your password from a link

Invitations and password resets both arrive as a link that opens a **Set your password** page (titled **Join Loomcast** for a new invitation).

1. Open the link exactly as you received it.
2. Type a **New password** of at least 12 characters, and type it again in **Confirm password**.
3. Press **Set password**, then sign in with the new password.

Each link works once. Invitation links last 7 days and reset links 24 hours; the page shows when yours expires. If the page says "This link has expired or was already used", ask the owner for a new one. Setting a new password from a reset link ends your other sessions.

## A tour of the screen

Loomcast is organised by workspace. A workspace is one brand, such as "Unfolded" or "Maths is Beautiful", and holds that brand's channels, calendar, library, review queue, approvals, analytics, chat, knowledge base, series and competitor research. Everyone who can sign in sees every workspace. See [Workspaces and the producer chat](workspaces.md).

After you sign in, Loomcast opens the workspace you last worked in, on its overview. The first time, or when there is no active workspace yet, it opens the workspaces list, where you create one.

![The workspace overview: the sidebar on the left, with the workspace switcher at the top](images/workspace-overview.png)

### The sidebar

The top of the sidebar is the **workspace switcher**: the open workspace's icon and name. Press it to switch to another workspace, to see **All workspaces**, or to create a **New workspace…**.

Below it are the pages of the open workspace:

| Item | What it is for |
|---|---|
| **Overview** | The workspace's description, counts, recent knowledge and conversations, and its channels |
| **Calendar** | Planned and queued posts on the workspace's channels and the open slots, by week or month |
| **Library** | The workspace's videos, with search and filters by state, series and target date |
| **Review** | The workspace's videos waiting for a decision, nearest target date first |
| **Approvals** | Videos that must be approved before their slot, and missed posts |
| **Analytics** | How the workspace's published posts perform |

Under **Studio** are the production tools: **Chat** (the producer chat), **Knowledge** (the knowledge base), **Series** (series and their formats) and **Competitors** (competitor research).

Below them, **Channels** lists the workspace's social accounts. Pressing a channel opens the calendar filtered to that channel. A lock icon means the platform can only dry-run on this server; an amber dot means the channel needs reconnecting. The settings icon next to the heading opens **Workspace settings → Channels**.

At the bottom of the sidebar:

- **Workspace settings** holds the open workspace's name, description, icon, colour, time zone and archiving (**General**), its **Channels** and its **API clients** (owner only). See [Settings](settings.md#workspace-settings).
- **Guide** opens these pages. Each page lists its sections under **On this page**, and the command palette finds guide pages too: type a word such as "pair" or "offline".
- **Account settings** holds what is not part of any one workspace: devices, access tokens, members (owner only) and the scheduler. See [Settings](settings.md#account-settings).
- **The user menu** (your name and email) has the **Theme** choice (**Light**, **Dark** or **System**) and **Log out**.

The button at the top left of the page hides or shows the sidebar (⌘B, or Ctrl+B).

### The top bar

- **Breadcrumbs** show where you are, for example Rust in 60 seconds / Chat. Each part is a link.
- **Search or jump to…** opens the command palette. Press ⌘K (Ctrl+K on Windows and Linux) from anywhere. Type to find pages, workspaces, videos, knowledge base entries and guide pages, or to run actions such as **New workspace** and switching the theme.
- **The studio status pill** shows **Studio online** when at least one paired studio agent is connected, **Studio offline** when none is, and **No studio** when none has been paired yet. Hover over it for details; press it to open **Account settings → Devices**.

## The life of a video

Every video in Loomcast follows the same path. In short:

1. **Plan.** A workspace holds the brand's series, and each series has a format: its tone, length, voice, look and cadence. See [Workspaces and the producer chat](workspaces.md) and [Series and formats](series-and-formats.md).
2. **Idea.** A video starts as an idea: a title and an optional pitch. You add ideas yourself, or the server plans one for each upcoming slot of the series' cadence.
3. **Produce.** The studio agent writes the script, cuts the storyboard, records the voice and renders the video. Each step runs as a job on the Mac. The states are **Idea**, **Script**, **Storyboard**, **Voice** and **Render**.
4. **Review.** The finished video is **In review** and waits in **Review**. You approve it, ask for changes (the producer revises it and brings it back) or reject it. See [Videos and review](videos-and-review.md).
5. **Schedule.** An approved video is queued on each channel of its series for its slot, and becomes **Scheduled**. See [Publishing](publishing.md).
6. **Publish.** At the slot the server sends the post, or, while a channel is in dry run, records exactly what it would have sent. The video becomes **Published**.

Research feeds every step: the [knowledge base](knowledge-base.md) and [competitor research](competitor-research.md) are what the studio agent reads before it writes.

## Roles

Loomcast has two roles. They apply to every workspace: there is no per-workspace membership.

| Role | Who | What they can do |
|---|---|---|
| **Owner** | One person, the account created when Loomcast was installed | Everything, including **Account settings → Members** (invite people, send new password links, disable access), each workspace's **API clients**, access tokens with the `mcp:admin` scope and the operations status |
| **Admin** | Everyone the owner invites | Everything else: workspaces and their settings, channels, series, formats, reviews, the calendar, devices, their own access tokens and **Account settings → Scheduler** |

There is exactly one owner, and the owner's account cannot be disabled. When the owner disables someone's access, that person is signed out everywhere, their access tokens stop working and the studio agents they paired are disconnected. Their work stays in the workspaces.

## First-time setup checklist

Do these once, in this order. Each step links to the page with the details.

1. **Pair the studio agent.** Install the studio agent on the Mac that will do the producing and pair it from **Account settings → Devices**. Until it is paired, the status pill reads **No studio** and nothing gets produced. One studio agent works for every workspace. See [The studio agent](studio-agent.md).
2. **Create a workspace for your brand.** Press **New workspace** on the workspaces list, or **New workspace…** in the switcher, and give it a name and a description. Then open **Workspace settings** to set its icon, colour and time zone. See [Workspaces and the producer chat](workspaces.md#creating-a-workspace).
3. **Connect the workspace's channels.** In **Workspace settings → Channels**, press **Connect** and sign in with the platform. The connect page asks which workspace the accounts join; it starts with the one you came from. Every new channel starts in dry run, so nothing goes out until you decide. See [Channels, calendar and publishing](publishing.md#connecting-an-account).
4. **Add a series.** In **Series**, create a series, set its format and switch on the channels it publishes to. See [Series and formats](series-and-formats.md).
5. **Add knowledge.** Save reference videos, decisions and brainstorms in **Knowledge**, so the studio agent writes in your voice from the first script. See [The knowledge base](knowledge-base.md).

Repeat steps 2 to 5 for each further brand. When the pill shows **Studio online**, send a first message in the workspace's **Chat** to check that the studio agent answers. If something does not work, see [Troubleshooting](troubleshooting.md).
