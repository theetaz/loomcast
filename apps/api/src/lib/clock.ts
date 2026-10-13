/** Source of the current time. Injected so tests can move time forward. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
