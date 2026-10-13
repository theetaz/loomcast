# Bridge protocol

The bridge connects the API to the studio agent, the daemon that runs jobs on a workstation.
The agent opens one outbound WebSocket to the API, so the workstation needs no inbound ports.
Everything below is version 1 of the protocol. The schemas live in
`packages/contracts/src/bridge/`, `src/jobs/` and `src/api/devices.ts`; the server side is
`apps/api/src/modules/bridge/` and `src/modules/jobs/`, and the agent side is
`apps/studio-agent/src/`.

| | |
|---|---|
| Endpoint | `GET /bridge/v1`, upgraded to a WebSocket, on the API's own port |
| Version | `PROTOCOL_VERSION = 1`, sent as `v` in every envelope and as `protocol` in `hello` |
| Frames | JSON text frames only, at most 1 MiB (`BRIDGE_LIMITS.maxPayloadBytes`); no compression |
| Auth | `Authorization: Bearer lc_dev_…` on the upgrade request |

The hub runs only when the API is served by `startServer` (it attaches to the Node HTTP
server's `upgrade` event), never under `app.request()`. In development the Vite dev server
proxies `/bridge` with WebSocket support, so an agent paired with `http://localhost:5173`
reaches the API on port 8790. Behind a reverse proxy, forward the `Upgrade` and `Connection`
headers and keep the read timeout above 20 seconds (the ping interval).

## Pairing

A device is paired once, with a single-use code from the web app.

```text
 Browser (Settings → Devices)       API                              Studio agent
   │ POST /api/devices/pairing-codes  │                                    │
   │ ───────────────────────────────► │ store sha256 of the code,          │
   │ ◄─────────────────────────────── │ expires in 10 minutes              │
   │ 201 {code: "ABCD-EFGH",          │                                    │
   │      expiresAt}                  │                                    │
   │                                  │   POST /api/bridge/pair            │
   │                                  │   {code, name, platform,           │
   │                                  │    agentVersion}                   │
   │                                  │ ◄───────────────────────────────── │
   │                                  │ mark the code used, create the     │
   │                                  │ device and an lc_dev_ token        │
   │                                  │ ─────────────────────────────────► │
   │                                  │   201 {deviceId, token}            │ write config.json (0600)
```

- **Codes** look like `XXXX-XXXX` (40 bits of entropy), last 10 minutes and work once. Only
  their hash is stored. Each signed-in user may create 10 codes a minute.
- **`POST /api/bridge/pair`** needs no session. It is limited to 10 attempts a minute per client
  address, must be sent as `application/json`, and is refused (`403`) when it carries an
  `Origin` other than the app's, because only a web page would send one.
- **The device token** is `lc_dev_` followed by a random secret. It is returned once, with
  `Cache-Control: no-store`; the server keeps only its hash, with kind `device` and scope
  `bridge`.
- **The agent** stores `{serverUrl, deviceId, token, workspaceRoot, concurrency}` in
  `~/.config/loomcast-agent/config.json` (directory 0700, file 0600). It accepts plain `http`
  only for `localhost`, `127.0.0.1` and `[::1]`.

Pairing publishes no live event. The device appears online in the web app when it connects.

## Connecting

The upgrade request is authenticated before the WebSocket is accepted; a refused request gets a
plain HTTP status and no socket.

| Check | Refusal |
|---|---|
| The request carries an `Origin` header (only browsers send one), which blocks cross-site WebSocket hijacking | `403` |
| No bearer token, an unknown or revoked token, a token without the `bridge` scope, or no device for the token | `401` |
| The device is revoked | `403` |
| The server is shutting down | `503` |

After the upgrade the agent must send `hello` first. The server answers `hello.ok` and sends
nothing else before it.

```text
 Studio agent                                     API (bridge hub)
   │ GET /bridge/v1  Authorization: Bearer lc_dev_…  │
   │ ──────────────────────────────────────────────► │ verify the token and device
   │ ◄────────────────────────────────────────────── │ 101 Switching Protocols
   │ hello {protocol: 1, agentVersion, platform,     │
   │        jobTypes, credits, resume}               │
   │ ──────────────────────────────────────────────► │ settle the resume list,
   │                                                 │ record the device online,
   │                                                 │ publish device.status online
   │ ◄────────────────────────────────────────────── │ hello.ok {deviceId, serverTime,
   │                                                 │   heartbeatMs, leaseMs, limits}
   │ ◄────────────────────────────────────────────── │ job.cancel for resumed jobs it must stop
   │ ◄────────────────────────────────────────────── │ job.assign … (dispatch round)
```

- **One connection per device.** A newer connection supersedes the older one, which is closed
  with `4409`. The new connection's `hello` waits until the old one has handled every message it
  received.
- **Revocation.** Revoking a device in Settings closes its live socket with `4403` and revokes
  its token.
- **Presence.** A device is online from its `hello` until its socket closes. Both changes are
  published as the `device.status` live event and stored as `devices.last_seen_at`.

## Envelope

Every frame is one JSON object:

```ts
{
  v: 1,               // protocol version
  id: string,         // ULID of this message
  type: string,       // message type, 1 to 64 characters
  ts: string,         // ISO 8601 timestamp
  ref?: string,       // ULID of the message being answered, when there is one
  payload: object,
}
```

`encode(draft)` in the contracts stamps `v`, a new `id` and `ts`, validates the message and
refuses one over the size limit, so a sender never makes the other side close the socket.
`parseAgentMessage` and `parseServerMessage` validate incoming frames.

## Messages from the agent

| Type | Payload | Notes |
|---|---|---|
| `hello` | `{protocol: 1, agentVersion, platform, jobTypes: JobType[], credits: {producer, render}, resume: [{jobId, lastAckedSeq}]}` | First message on every connection. At most 64 job types and 256 resume entries |
| `job.accept` | `{jobId}` | Starts an assigned job |
| `job.reject` | `{jobId, reason?}` | Declines an assigned job (see below) |
| `job.event` | `{jobId, seq, kind, data}` | Durable: stored once per `(jobId, seq)` and acked |
| `job.stream` | `{jobId, kind: "assistant.delta", text}` | Ephemeral: relayed to the browser, never stored or acked, at most 32 768 characters |
| `job.heartbeat` | `{jobIds}` | Every 15 seconds while jobs run; extends their leases |
| `job.complete` | `{jobId, result}` | `result` is checked against the job type's result schema |
| `job.fail` | `{jobId, error: {code, message, retryable}}` | |
| `credits` | `{producer, render}` | Free slots per concurrency class, sent whenever they change |

### Durable event kinds

Sequence numbers start at 1 for each job and increase by one per event. A job type may only emit
the kinds its registry entry lists; another kind is not stored and is answered with an `error`
message (`invalid_event`), but it is still acked.

| Kind | `data` |
|---|---|
| `status` | `{state, message?, progress?}`: a coarse step such as `starting` or `rendering`; `progress` from 0 to 1 |
| `session` | `{sessionId}`: the producer session the job runs in |
| `tool.activity` | `{tool, summary}`: one tool use with a short, redacted summary; published as the `job.activity` live event |
| `assistant.message` | `{text}`: a complete reply; for `producer.chat` it becomes an assistant message in the conversation |
| `usage` | token and cost counts reported by the producer runtime |
| `log` | `{level: debug\|info\|warn\|error, message}` |

## Messages from the server

| Type | Payload | Notes |
|---|---|---|
| `hello.ok` | `{deviceId, serverTime, heartbeatMs: 20000, leaseMs: 600000, limits: {maxPayloadBytes, maxStreamTextLength}}` | Answer to `hello` |
| `job.assign` | `{job: {id, type, attempt, payload, projectId, conversationId?}, leaseMs, credentials?}` | The agent validates `payload` against the job type and rejects a bad one |
| `job.cancel` | `{jobId}` | Stop the job; the agent answers `job.fail {code: "cancelled"}` |
| `ack` | `{jobId, upToSeq}` | Cumulative: every durable event up to `upToSeq` is stored |
| `error` | `{code, message}` | A problem with one message that does not close the connection |

`credentials` is optional. It carries a per-job MCP token (`{mcp: {endpoint, token, expiresAt}}`,
where `endpoint` is a server path such as `/mcp`) for job types whose registry entry grants MCP
access. The agent keeps it in memory for that job only; agents must accept assignments without
it.

## Close codes

| Code | Meaning | What the agent does |
|---|---|---|
| `4400` | A frame failed to parse or validate, a binary frame, or a message before `hello` | Reconnects |
| `4401` | Unauthorized | Logs "re-pair required" and exits |
| `4403` | The device was revoked | Logs "re-pair required" and exits |
| `4409` | Superseded by a newer connection of the same device | Exits |
| `4426` | Unsupported protocol version | Exits; update the agent |
| `1001` | The server is shutting down | Reconnects |
| `1008` | More than 1 000 messages waiting to be handled | Reconnects |
| `1011` | The server failed while handling a message | Reconnects |

The agent exits with code 0 after `4401`, `4403`, `4409` and `4426` (and after HTTP `401` or
`403` on the upgrade), so a service manager does not restart it into the same refusal.

## Job lifecycle

```text
            enqueue (REST, MCP, scheduler)
                     │
                     ▼
   ┌──────────────► queued ──────────── cancel ────────────► cancelled
   │                 │ dispatch round
   │                 ▼
   │ requeue ◄──── dispatched ── job.reject ──► queued (attempt not counted)
   │ (not accepted   │ job.accept                or failed (invalid payload)
   │  in 30 s, lost  ▼
   │  on reconnect) running ── job.complete ──► succeeded
   │                 │  │
   │                 │  └──── job.fail ───────► failed, cancelled, or queued
   │                 │                           (retryable and the type re-queues)
   └──── lease expired, type re-queues ◄──┘
                     lease expired otherwise ──► failed {code: "interrupted", retryable: true}
```

1. **Queued.** Jobs are created by REST (a chat message enqueues `producer.chat`), MCP or the
   scheduler, after the payload passes the job registry. They wait here while no agent is
   connected.
2. **Dispatch.** A round runs when an agent sends `hello` or `credits`, when a job is enqueued,
   when a job finishes, and every 5 seconds as a safety net. For each connected agent it claims
   queued jobs with `SELECT … FOR UPDATE SKIP LOCKED`, filtered by the job types the agent
   advertised, by its free credits per concurrency class (minus assignments not yet answered),
   and by `device_affinity` (a conversation's jobs go to the device that holds its producer
   session, unless that device is revoked). Claimed jobs become `dispatched`, the attempt is
   counted and `job.assign` is sent.
3. **Accept or reject.** `job.accept` makes the job `running` and starts its lease. A dispatched
   job not accepted within 30 seconds goes back to the queue. `job.reject` puts the job back
   without counting the attempt; reasons starting with `invalid_payload` or `invalid_assignment`
   fail it instead. After `no_credits` the server waits for the agent's next `credits`; after
   `unsupported_job_type` it stops sending that type to this connection.
4. **Running.** Durable events, heartbeats and acceptance extend the lease (`leaseMs`, 10
   minutes). Stream deltas are published to the browser as `conversation.message.delta`.
5. **Finished.** `job.complete` stores the result if it matches the registry; otherwise the job
   fails with `invalid_result`. `job.fail` with `retryable: true` re-queues job types whose
   policy is `requeue` while `attempt < max_attempts`; otherwise the job fails, or ends as
   `cancelled` when a cancel was requested and the code is `cancelled`. Outcomes for a job that
   already finished, or that belongs to another device, are ignored.

Every status change is published as the `job.updated` live event. Re-queuing deletes the job's
stored events, because the next attempt may run on another agent whose sequence starts at 1.

### Retry policy

| Job type | Class | Attempts | When the lease expires |
|---|---|---|---|
| `system.ping` | producer | 3 | Re-queued |
| `producer.chat` | producer | 1 | Fails as `interrupted` (retryable); the user retries from the conversation |

Later job types are listed in `jobRegistry` in `packages/contracts/src/jobs/registry.ts`.

### Cancelling

```text
 Browser               API                                   Studio agent
   │ POST /api/jobs/:id/cancel                                  │
   │ ───────────────────► │ queued: cancelled at once           │
   │                      │ dispatched or running:              │
   │                      │ set cancel_requested_at,            │
   │                      │ publish job.updated                 │
   │                      │ ─── job.cancel {jobId} ───────────► │ abort the handler
   │                      │ ◄── job.fail {code: "cancelled"} ── │
   │ ◄── job.updated ──── │ cancelled                           │
```

A job the server no longer gives an agent (for example, one that was re-queued while the agent
was away) is stopped with `job.cancel` when the agent mentions it in `job.heartbeat` or
`hello.resume`, or tries to accept it.

## Chat turn

A `producer.chat` job from a message to the streamed reply:

```text
 Browser                  API                                     Studio agent
   │ POST /api/conversations/:id/messages {text, clientMessageId}    │
   │ ──────────────────────► │ store the user message,              │
   │                         │ enqueue producer.chat                │
   │ ◄── 201 {message, job}  │                                      │
   │ ◄── job.updated queued  │ dispatch round                       │
   │                         │ ── job.assign ─────────────────────► │
   │                         │ ◄─ job.accept ────────────────────── │
   │ ◄── job.updated running │ ◄─ credits {producer: 0, …} ──────── │
   │                         │ ◄─ job.event #1 session ──────────── │ start or resume the
   │                         │ ── ack {upToSeq: 1} ───────────────► │ producer session
   │ ◄── job.activity        │ ◄─ job.event #2 tool.activity ────── │
   │                         │ ── ack {upToSeq: 2} ───────────────► │
   │ ◄── message.delta       │ ◄─ job.stream "Bridges carry …" ──── │ (batched every 100 ms)
   │ ◄── message.created     │ ◄─ job.event #3 assistant.message ── │ the full reply
   │                         │ ── ack {upToSeq: 3} ───────────────► │
   │ ◄── job.updated         │ ◄─ job.complete {sdkSessionId, …} ── │
   │     succeeded           │ store sdkSessionId and the device    │
   │                         │ on the conversation                  │
   │                         │ ◄─ credits {producer: 1, …} ──────── │
```

- **Session continuity.** The next turn's payload carries the conversation's
  `producerSessionId`, and the job has affinity to the device that holds the session. The agent
  resumes the session in the same working directory, `~/Loomcast/projects/<projectId>`; a job
  that moves to another device starts a new session.
- **Duplicate sends.** `clientMessageId` makes a repeated post return the stored message and its
  job instead of enqueuing again.
- **Several replies.** A turn may emit several `assistant.message` events (text before and after
  tool calls); each becomes a message. `result.finalText` repeats the last one and is not stored
  again.

## Reliability

**Heartbeats.** The server pings every socket every 20 seconds and terminates one that misses two
pongs in a row. The agent treats the server as gone after 60 seconds without a ping, drops the
socket and reconnects.

**Reconnects.** The agent reconnects with full-jitter backoff starting at 1 second and doubling to
a 60-second cap; a connection that stays up for 60 seconds resets the backoff.

**Durable outbox.** The agent appends each durable event to
`~/.config/loomcast-agent/outbox/<jobId>.jsonl` before sending it, trims the file when the server
acks, and re-sends from `lastAckedSeq + 1` after a reconnect. The server stores events with
`ON CONFLICT (job_id, seq) DO NOTHING`, so a replay is harmless.

**Resume.** On reconnect the agent lists its unfinished jobs in `hello.resume`. The server keeps
running the ones still claimed by this device (and leases them again), answers `job.cancel` for
the rest, and re-queues jobs it had dispatched to the device that the agent does not mention,
since their assignment was lost. A job whose agent stays away keeps its lease for 10 minutes;
then the reaper (every 15 seconds) applies the job type's lease policy.

**Outcomes after a reconnect.** The server never acks `job.complete` or `job.fail`; the agent
re-sends an unconfirmed outcome after reconnecting, and a duplicate is ignored. The agent's
journal (`journal.jsonl`, kept for 7 days) answers a re-assigned job that already finished with
its stored outcome instead of running it again.

**Backpressure.** When more than 512 KiB is buffered on the socket, the agent drops `job.stream`
deltas. Durable events always arrive, and the final `assistant.message` carries the full text.

## Limits and timings

| Name | Value | Constant |
|---|---|---|
| Largest frame | 1 MiB | `BRIDGE_LIMITS.maxPayloadBytes` |
| Longest stream delta | 32 768 characters | `BRIDGE_LIMITS.maxStreamTextLength` |
| Job types in `hello` | 64 | `BRIDGE_LIMITS.maxJobTypes` |
| Jobs in `hello.resume` or one heartbeat | 256 | `BRIDGE_LIMITS.maxJobsPerMessage` |
| Agent drops deltas above | 512 KiB buffered | `BRIDGE_LIMITS.backpressureBytes` |
| Server ping interval | 20 s | `BRIDGE_TIMINGS.serverPingMs` |
| Missed pongs before termination | 2 | `BRIDGE_TIMINGS.missedPongsBeforeTerminate` |
| Agent's dead-server timeout | 60 s | `BRIDGE_TIMINGS.agentDeadServerMs` |
| Job heartbeat | 15 s | `BRIDGE_TIMINGS.jobHeartbeatMs` |
| Stream batching | 100 ms | `BRIDGE_TIMINGS.streamBatchMs` |
| Accept timeout | 30 s | `BRIDGE_TIMINGS.acceptTimeoutMs` |
| Lease and disconnect grace | 10 min | `BRIDGE_TIMINGS.leaseMs` |
| Reconnect backoff | 1 s to 60 s, reset after 60 s | `BRIDGE_TIMINGS.reconnect` |
| Dispatch safety-net tick | 5 s | `DISPATCH_INTERVAL_MS` (API) |
| Lease sweep | 15 s | `REAPER_INTERVAL_MS` (API) |
| Pairing exchanges | 10 a minute per address | `PAIRING_LIMITS.pairPerIp` (API) |

## Testing against the bridge

- `apps/api/test/bridge-support.ts` serves the app on an ephemeral port with the hub attached
  (`startBridgeServer`) and provides `FakeAgent`, a minimal agent built from the contracts codec.
- `apps/studio-agent/test/` runs the agent against an in-process fake bridge server.
- `tests/e2e/support/fake-agent.ts` pairs through the real API and answers `producer.chat` with
  streamed text. The end-to-end smoke uses it, and it runs as a script for local development; see
  [local development](local-development.md#a-studio-agent-without-a-producer-runtime).
