/** Bridge protocol version, sent as `v` in every envelope and as `protocol` in `hello`. */
export const PROTOCOL_VERSION = 1;

/** WebSocket endpoint of the bridge. */
export const BRIDGE_PATH = "/bridge/v1";

/** Application close codes used on the bridge socket. */
export const CLOSE_CODES = {
  /** A message failed to parse or validate. */
  malformedMessage: 4400,
  /** The device token is missing or invalid. */
  unauthorized: 4401,
  /** The device was revoked. The agent must be paired again. */
  revoked: 4403,
  /** A newer connection from the same device replaced this one. */
  superseded: 4409,
  /** The peer speaks a protocol version this side does not support. */
  unsupportedProtocol: 4426,
} as const;
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/** Size limits. Both sides enforce them; `hello.ok` repeats them to the agent. */
export const BRIDGE_LIMITS = {
  /** Largest text frame, in UTF-8 bytes (the `ws` `maxPayload`). */
  maxPayloadBytes: 1024 * 1024,
  /** Longest text in one `job.stream` delta batch. */
  maxStreamTextLength: 32_768,
  /** Most job types an agent may advertise in `hello`. */
  maxJobTypes: 64,
  /** Most jobs in `hello.resume` and in one `job.heartbeat`. */
  maxJobsPerMessage: 256,
  /** Above this many buffered bytes the agent drops `job.stream` deltas. */
  backpressureBytes: 512 * 1024,
} as const;

/** Timings shared by the server and the studio agent. */
export const BRIDGE_TIMINGS = {
  /** The server pings every socket at this interval (sent as `hello.ok.heartbeatMs`). */
  serverPingMs: 20_000,
  /** A socket that misses this many pongs in a row is terminated. */
  missedPongsBeforeTerminate: 2,
  /** The agent treats the server as gone after this long without a ping. */
  agentDeadServerMs: 60_000,
  /** The agent sends `job.heartbeat` at this interval while jobs run. */
  jobHeartbeatMs: 15_000,
  /** The agent batches `job.stream` deltas at this interval. */
  streamBatchMs: 100,
  /** A dispatched job that is not accepted within this time goes back to `queued`. */
  acceptTimeoutMs: 30_000,
  /**
   * Job lease (sent as `leaseMs`). Heartbeats and events extend it, so it is also the grace period
   * for a job whose agent disconnected mid-run.
   */
  leaseMs: 10 * 60_000,
  /** Reconnect backoff: full jitter from `initialMs`, doubling up to `maxMs`. */
  reconnect: {
    initialMs: 1_000,
    maxMs: 60_000,
    /** A connection that stays up this long resets the backoff. */
    resetAfterMs: 60_000,
  },
} as const;
