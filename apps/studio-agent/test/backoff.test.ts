import { describe, expect, it } from "vitest";
import { Backoff, backoffCeiling, DEFAULT_BACKOFF, fullJitterDelay } from "../src/backoff";

describe("reconnect backoff", () => {
  it("doubles the ceiling from 1 s and caps it at 60 s", () => {
    const ceilings = Array.from({ length: 9 }, (_, attempt) => backoffCeiling(attempt));
    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(backoffCeiling(10_000)).toBe(60_000);
    expect(backoffCeiling(-1)).toBe(1_000);
  });

  it("keeps every full-jitter delay inside [0, ceiling)", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(fullJitterDelay(attempt, DEFAULT_BACKOFF, () => 0)).toBe(0);
      const highest = fullJitterDelay(attempt, DEFAULT_BACKOFF, () => 0.999_999);
      expect(highest).toBeLessThan(backoffCeiling(attempt));
      expect(highest).toBeLessThanOrEqual(60_000);
      const random = fullJitterDelay(attempt);
      expect(random).toBeGreaterThanOrEqual(0);
      expect(random).toBeLessThan(backoffCeiling(attempt));
    }
  });

  it("grows per failed attempt and resets after a stable connection", () => {
    let now = 0;
    const backoff = new Backoff(
      DEFAULT_BACKOFF,
      () => 0.5,
      () => now,
    );
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([500, 1_000, 2_000]);

    // A short-lived connection does not reset the count.
    backoff.connected();
    now += 59_999;
    backoff.disconnected();
    expect(backoff.next()).toBe(4_000);

    // A connection that lasted 60 s does.
    backoff.connected();
    now += 60_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(500);
  });
});
