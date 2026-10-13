// Choosing the topic of a planned item. Pure: the planner passes the series' topic history.

/** How many of the most recently used topics a new item never repeats, while others remain. */
export const RECENT_TOPIC_WINDOW = 3;

/** A topic an item of the series used, and when (the item's slot, or its creation). */
export interface TopicUse {
  topic: string;
  at: Date | number;
}

export interface PickTopicInput {
  /** The format's topic pool, in the owner's order. */
  pool: readonly string[];
  /** Topics, words or claims to stay away from: a pool topic containing one is never picked. */
  avoid: readonly string[];
  /** Earlier uses, in any order. */
  history: readonly TopicUse[];
  /** How many of the latest distinct topics to skip; `RECENT_TOPIC_WINDOW` by default. */
  recent?: number;
}

function topicKey(topic: string): string {
  return topic.trim().toLocaleLowerCase("en-US");
}

function timeOf(at: Date | number): number {
  return typeof at === "number" ? at : at.getTime();
}

/**
 * The least recently used topic of the pool: never-used topics first (in pool order), then the
 * one whose last use is oldest. Topics that contain an `avoid` entry are left out, and so are the
 * last `recent` distinct topics used, unless that would leave nothing to pick. Topics compare
 * without case and surrounding spaces. Null when the pool has nothing usable.
 */
export function pickTopic(input: PickTopicInput): string | null {
  const avoid = input.avoid.map(topicKey).filter((key) => key.length > 0);
  const seen = new Set<string>();
  const candidates: { topic: string; key: string; index: number }[] = [];
  input.pool.forEach((topic, index) => {
    const key = topicKey(topic);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    if (avoid.some((word) => key.includes(word))) return;
    candidates.push({ topic: topic.trim(), key, index });
  });
  if (candidates.length === 0) {
    return null;
  }

  const lastUsed = new Map<string, number>();
  for (const use of input.history) {
    const key = topicKey(use.topic);
    const at = timeOf(use.at);
    if (at > (lastUsed.get(key) ?? Number.NEGATIVE_INFINITY)) lastUsed.set(key, at);
  }
  const recentCount = Math.max(0, Math.floor(input.recent ?? RECENT_TOPIC_WINDOW));
  const recent = new Set(
    [...lastUsed.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, recentCount)
      .map(([key]) => key),
  );
  const fresh = candidates.filter((candidate) => !recent.has(candidate.key));
  const eligible = fresh.length > 0 ? fresh : candidates;

  let best = eligible[0];
  for (const candidate of eligible) {
    const used = lastUsed.get(candidate.key) ?? Number.NEGATIVE_INFINITY;
    const bestUsed =
      best === undefined
        ? Number.POSITIVE_INFINITY
        : (lastUsed.get(best.key) ?? Number.NEGATIVE_INFINITY);
    if (used < bestUsed) best = candidate;
  }
  return best?.topic ?? null;
}
