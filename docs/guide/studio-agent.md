# Setting up the studio agent

The studio agent is a small program that runs on your Mac. It connects to Loomcast, picks up jobs (scripts, storyboards, voice, renders, research) and runs them with the producer session and the studio runtime on that Mac. This page takes you from a new Mac to **Studio online**.

## Pairing is not the same as running

Setting up the studio agent has two halves, and both are needed:

1. **Pairing** registers the Mac with Loomcast and gives it a device token. After pairing, the Mac appears under **Account settings → Devices**.
2. **Running** starts the agent program, which connects with that token and waits for jobs.

A Mac that is paired but not running shows **Offline** with **Last seen** **Never**, and the top bar shows **Studio offline**. Nothing is wrong with the pairing: the agent simply has not connected yet. Jobs wait in the queue until it does. Finish the steps below through [Install the background service](#5-install-the-background-service) and the device turns **Online**.

## What the Mac needs

The agent runs on macOS only: the background service uses launchd, which is part of macOS. Before you pair, install and check the following.

| What | Why | How to check |
|---|---|---|
| Node.js and pnpm | The agent is a Node program run from the repository | `node --version` (22.12 or later) and `pnpm --version` |
| A checkout of the Loomcast repository, with dependencies installed | The agent and the studio runtime run from it | `pnpm install` in the repository folder |
| The producer runtime, installed and signed in | Scripts, storyboards, revisions, chat and research analyses run in a producer session | See [Studio runtime](../studio-runtime.md) |
| ffmpeg and ffprobe | Voice, render and video measurements | `ffmpeg -version`, for example installed with Homebrew |
| yt-dlp | Downloading public videos for [competitor research](competitor-research.md) only | `yt-dlp --version`, for example `brew install yt-dlp` |
| The voice provider (ElevenLabs) key | Voice takes and transcription of reference media | Set in step 3 below |

Everything else keeps working without yt-dlp; only competitor videos fail. Without the voice key, voice and transcription jobs fail.

## Set it up step by step

Run the commands in the repository folder on the Mac.

### 1. Create a pairing code

Open **Account settings → Devices** and select **Pair a device**. The **Pair a studio agent** dialog shows a one-time **Pairing code** and the command to run on the Mac, with a copy button. The code expires after 10 minutes and works once. If it runs out, select **Get a new code**.

![The Pair a studio agent dialog with a pairing code, its countdown and the command to run on the Mac](images/settings-devices-pair.png)

You can leave the dialog open. It shows **Waiting for the agent to connect…** until the agent connects in step 5, then closes itself with **Studio agent paired**.

### 2. Pair the Mac

Copy the command from the dialog, or type it with your Loomcast address and the code:

```bash
pnpm agent pair --server https://loomcast.example.com --code ABCD-EFGH
```

Add `--name "Studio Mac"` to choose the name shown in **Account settings → Devices**. Without it, the Mac's host name is used. The address must start with `https://` (plain `http://` is only accepted for `localhost`).

The command answers `Paired with … as device …` and stores the device token in `~/.config/loomcast-agent/config.json`. The Mac now appears in the device list, still **Offline**.

### 3. Store the voice provider key

```bash
pnpm agent secrets set voice-provider-key
```

Paste the key at the hidden prompt and press Return. You can also pipe it in, for example straight from the clipboard:

```bash
pbpaste | pnpm agent secrets set voice-provider-key
```

The key is never taken as a command-line argument, so it does not end up in your shell history or the process list. It is stored in `~/.config/loomcast-agent/secrets.env`, readable only by you. To remove it, run `pnpm agent secrets unset voice-provider-key`.

### 4. Build the agent

The background service runs the built agent, so build it once:

```bash
pnpm --filter @loomcast/studio-agent build
```

### 5. Install the background service

```bash
pnpm agent service install
```

This writes a launchd agent to `~/Library/LaunchAgents/com.loomcast.studio-agent.plist` and starts it straight away. From then on:

- it starts when you log in to the Mac;
- if it crashes, launchd starts it again (at most once every 10 seconds);
- if it stops cleanly, it stays stopped. The agent only stops cleanly when restarting cannot help: the server refused its token (the device was revoked, so it must be paired again) or another connection of the same device replaced it;
- everything it prints goes to `~/Library/Logs/Loomcast/studio-agent.log`.

### 6. Check that it is connected

```bash
pnpm agent service status
```

Look for `Service: loaded, state running`. Then read the end of the log:

```bash
tail -n 20 ~/Library/Logs/Loomcast/studio-agent.log
```

A line with `connected to the bridge` means the agent is connected. In the web app, **Account settings → Devices** now shows the Mac as **Online** with **Last seen** **now**, and the top bar shows **Studio online**.

![Account settings, Devices: one Mac online and seen now, another offline, with Studio online in the top bar](images/settings-devices.png)

If the device stays **Offline**, see [Troubleshooting](troubleshooting.md#the-device-is-offline-or-the-top-bar-says-studio-offline).

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm agent service status` | Whether the service is installed and running, with its log path |
| `pnpm agent service install` | Installs the service, or restarts it when it is already installed |
| `pnpm agent service uninstall` | Stops the service and removes it from launchd. The log is kept |
| `pnpm agent status` | Prints the agent's configuration (the device token is shown as `[redacted]`) and whether the voice provider key is set |
| `pnpm agent run` | Runs the agent in the foreground of your terminal, for debugging. Stop it with Ctrl+C |
| `pnpm agent --version` | Prints the agent's version, also shown in the **Agent** column of **Account settings → Devices** |

Use either the service or `pnpm agent run`, never both at the same time: the two connections would replace each other. To debug in the foreground, uninstall the service first, then install it again when you are done. `pnpm agent run --log-level debug` prints more detail.

## Configuration

The agent's settings live in `~/.config/loomcast-agent/config.json`. Pairing writes it. The keys are:

| Key | Meaning |
|---|---|
| `serverUrl` | Your Loomcast address |
| `deviceId` | This Mac's device record, set by pairing |
| `token` | The device token, set by pairing. Never share or paste it |
| `workspaceRoot` | Where jobs keep their files. Default `~/Loomcast`; each workspace works in `projects/<workspace id>` inside it. The folder keeps the name `projects` from before workspaces were renamed, so existing producer sessions and files keep working |
| `concurrency` | How many jobs run at the same time: `producer` (scripts, storyboards, revisions, chat, research) and `render` (voice, render and skill sync). Default 1 each |
| `ytDlpPath` | Optional. The yt-dlp program to use: an absolute path, or a name found on the service's `PATH`. Default `yt-dlp` |

Pairing again replaces `deviceId` and `token` but keeps `workspaceRoot`, `concurrency` and `ytDlpPath`.

### Edit the file safely

The file holds your device token, so it must stay readable only by you (mode 600). Edit it in a plain-text terminal editor, not a word processor that might change the quotes:

```bash
nano ~/.config/loomcast-agent/config.json
chmod 600 ~/.config/loomcast-agent/config.json
pnpm agent status
```

`pnpm agent status` reads the file back. If it reports that the file is not valid JSON or is invalid, fix the typo you made (a missing comma or quote) rather than pairing again. It also warns when other users can read the file. Restart the service afterwards with `pnpm agent service install`.

### Tools the service cannot find

The background service does not use your shell's `PATH`. It only looks in these folders:

- the folder of the Node binary that ran `pnpm agent service install`;
- `/opt/homebrew/bin` and `/usr/local/bin` (Homebrew);
- `/usr/bin` and `/bin`.

Tools installed anywhere else, for example through pyenv, pipx or asdf, are not found, even though they work in your terminal. The most common case is yt-dlp: competitor videos then fail with `downloader_missing`. Either install it with Homebrew (`brew install yt-dlp`), or point `ytDlpPath` at the real program, not a version-manager shim:

```bash
pyenv which yt-dlp
```

This prints the real path, such as `/Users/<you>/.pyenv/versions/<version>/bin/yt-dlp`. Add it to the config file as `"ytDlpPath": "<that path>"` (a full path; `~` is not expanded), then restart the service:

```bash
pnpm agent service install
```

The same applies to Node itself: the service keeps using the Node binary that installed it. If you switch Node versions with a version manager, run `pnpm agent service install` again with the new one.

## Keeping it up to date

After you pull new code, rebuild the agent and reinstall the service, which reloads it:

```bash
pnpm install
pnpm --filter @loomcast/studio-agent build
pnpm agent service install
```

Check **Account settings → Devices**: the **Agent** column shows the new version once it reconnects.

### Repository on an external drive

The service runs the built agent from inside the repository. If the repository lives on an external drive, the drive must be mounted when you log in. If it is not, the service cannot start. Plug the drive in and run `pnpm agent service install` again.

## Stopping, unpairing and removing

- **Stop the agent on this Mac:** `pnpm agent service uninstall`. The Mac stays paired; install the service again to bring it back.
- **Unpair a Mac:** in **Account settings → Devices**, select the unplug button (**Revoke**) on its row and confirm **Revoke device**. It disconnects at once and cannot take jobs until it is paired again. The agent logs that the server refused it and stops.
- **Pair again:** create a new code and run `pnpm agent pair …` again, then `pnpm agent service install` to restart the service with the new token.

## Security notes

- **Outbound only.** The agent opens one connection from the Mac to your Loomcast server. The Mac needs no open ports, and the server cannot reach into it.
- **A fixed list of jobs.** The agent runs only the job types it knows. It never runs a command sent in a job.
- **Private files.** The device token (`config.json`) and the voice provider key (`secrets.env`) are stored with mode 600 in a folder only you can open. The server keeps only a hash of the device token.
- **Scoped job tokens.** Producer sessions never see the device token. Each job gets its own short-lived token that only reaches that job's workspace, and only the tools that job type needs.
- **Lost Mac.** Revoke the device in **Account settings → Devices** and rotate the voice provider key. The owner's full checklist is in the [owner runbook](../runbooks/owner-runbook.md#7-a-lost-or-stolen-mac).

More detail: [security model](../security.md) and [bridge protocol](../bridge-protocol.md).
