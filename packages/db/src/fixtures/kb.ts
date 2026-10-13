import type { JsonObject, KbEntryKind } from "@loomcast/contracts";

/** A sample knowledge-base entry for the development seed and tests. */
export interface KbFixture {
  /** Stable key; the seed stores it as the dedupe key `seed:<key>` so reruns skip it. */
  key: string;
  kind: KbEntryKind;
  title: string;
  bodyMd: string;
  tags: string[];
  /** Kind-specific data, valid for `KB_ENTRY_DATA[kind]`. */
  data: JsonObject;
  /** Days before the seed runs at which the entry was last updated, so lists have an order. */
  daysAgo: number;
  /**
   * Set for `reference` entries only. The seed normalises the URL and detects the platform with
   * `normalizeReferenceUrl`. URLs are made up and never fetched.
   */
  reference?: {
    url: string;
    author: string;
    likedReason: string;
    transcript?: string;
  };
}

/** Thirty entries about planning short tech videos, covering every entry kind. */
export const KB_FIXTURES: readonly KbFixture[] = [
  {
    key: "brainstorm-rust-hooks",
    kind: "brainstorm",
    title: "Brainstorm: hooks for a Rust ownership short",
    bodyMd:
      "- Open on a compiler error and ask why it is right.\n" +
      "- Show two variables fighting over one value, then the borrow checker as referee.\n" +
      "- End on the one rule: one owner, many readers or one writer.",
    tags: ["rust", "hooks"],
    data: {},
    daysAgo: 1,
  },
  {
    key: "brainstorm-git-rebase",
    kind: "brainstorm",
    title: "Brainstorm: explaining git rebase in 30 seconds",
    bodyMd:
      "Treat commits as cards on a table. Rebase picks the cards up and lays them on a new base. " +
      "Contrast with merge, which tapes two piles together.",
    tags: ["git", "explainer"],
    data: {},
    daysAgo: 2,
  },
  {
    key: "brainstorm-series-names",
    kind: "brainstorm",
    title: "Series name ideas",
    bodyMd:
      "Thirty Second Internals, One Concept a Day, Under the Hood, Bytes Before Breakfast. " +
      "Shortlist the two that read well as a caption on a phone.",
    tags: ["series", "naming"],
    data: {},
    daysAgo: 3,
  },
  {
    key: "brainstorm-dns-visual",
    kind: "brainstorm",
    title: "Visual metaphors for how DNS resolves a name",
    bodyMd:
      "A relay of librarians: the root points to the shelf, the TLD to the row, the authoritative " +
      "server hands over the book. Caching is a sticky note on the front desk.",
    tags: ["networking", "dns", "visuals"],
    data: {},
    daysAgo: 4,
  },
  {
    key: "brainstorm-async-await",
    kind: "brainstorm",
    title: "Brainstorm: async and await without the jargon",
    bodyMd:
      "A waiter takes several orders instead of standing at the kitchen door. The event loop is the " +
      "waiter; await is the moment they walk away to serve someone else.",
    tags: ["javascript", "concurrency"],
    data: {},
    daysAgo: 5,
  },
  {
    key: "brainstorm-thumbnail-text",
    kind: "brainstorm",
    title: "Cover text that survives the feed",
    bodyMd:
      "Three words maximum, high contrast, placed in the top third so the caption bar never hides " +
      "it. Test each cover at thumbnail size before publishing.",
    tags: ["covers", "design"],
    data: {},
    daysAgo: 6,
  },
  {
    key: "brainstorm-sql-indexes",
    kind: "brainstorm",
    title: "Brainstorm: why a database index is like a book index",
    bodyMd:
      "Start with someone reading a whole book to find one word. Cut to the index at the back. " +
      "Then show the cost: every new page means updating the index too.",
    tags: ["databases", "sql"],
    data: {},
    daysAgo: 8,
  },
  {
    key: "brainstorm-docker-layers",
    kind: "brainstorm",
    title: "Docker image layers as a stack of transparent sheets",
    bodyMd:
      "Each instruction adds a sheet. Changing a low sheet forces every sheet above it to be redrawn, " +
      "which is why the dependency install goes before copying the source.",
    tags: ["docker", "visuals"],
    data: {},
    daysAgo: 10,
  },
  {
    key: "reference-fast-explainer",
    kind: "reference",
    title: "Instagram: one concept, one diagram, 25 seconds",
    bodyMd: "",
    tags: ["pacing", "diagrams"],
    data: {},
    daysAgo: 2,
    reference: {
      url: "https://www.instagram.com/reel/LoomcastSample01/",
      author: "sample.creator",
      likedReason: "The diagram builds in sync with the voice, so there is never dead air.",
      transcript:
        "Here is the whole idea in one picture. A request comes in, the cache answers first, and " +
        "only a miss goes to the database.",
    },
  },
  {
    key: "reference-question-hook",
    kind: "reference",
    title: "YouTube Shorts: opens with a question the viewer can answer",
    bodyMd: "",
    tags: ["hooks"],
    data: {},
    daysAgo: 3,
    reference: {
      url: "https://www.youtube.com/shorts/LoomcastSample02",
      author: "Sample Channel",
      likedReason: "The question makes me guess before the answer lands.",
      transcript:
        "Quick: what happens when you type a URL and press enter? Most people miss step two.",
    },
  },
  {
    key: "reference-threads-carousel",
    kind: "reference",
    title: "Threads: code screenshot with a single highlighted line",
    bodyMd: "",
    tags: ["code", "design"],
    data: {},
    daysAgo: 7,
    reference: {
      url: "https://www.threads.net/@sample.dev/post/LoomcastSample03",
      author: "sample.dev",
      likedReason: "Dimming everything but one line tells you exactly where to look.",
    },
  },
  {
    key: "reference-tiktok-whiteboard",
    kind: "reference",
    title: "TikTok: whiteboard explainer with jump cuts",
    bodyMd: "",
    tags: ["pacing", "whiteboard"],
    data: {},
    daysAgo: 9,
    reference: {
      url: "https://www.tiktok.com/@sample.teacher/video/1000000000000000001",
      author: "sample.teacher",
      likedReason: "Jump cuts remove every pause but the drawing stays continuous.",
      transcript: "Let me draw how a hash map stores keys. Each key becomes a number, the bucket.",
    },
  },
  {
    key: "reference-x-thread",
    kind: "reference",
    title: "X: terminal recording sped up with captions",
    bodyMd: "",
    tags: ["terminal", "captions"],
    data: {},
    daysAgo: 12,
    reference: {
      url: "https://x.com/sample_cli/status/1000000000000000002",
      author: "sample_cli",
      likedReason: "Captions name each command, so it works with the sound off.",
    },
  },
  {
    key: "reference-facebook-demo",
    kind: "reference",
    title: "Facebook: product demo that ends on a question",
    bodyMd: "",
    tags: ["cta"],
    data: {},
    daysAgo: 15,
    reference: {
      url: "https://www.facebook.com/reel/1000000000000000003",
      author: "Sample Studio",
      likedReason: "Ending on a question drives comments instead of a hard sell.",
    },
  },
  {
    key: "decision-vertical-format",
    kind: "decision",
    title: "Publish every short at 1080 by 1920",
    bodyMd: "",
    tags: ["format"],
    data: {
      decision: "Every short is rendered at 1080x1920, 30 fps.",
      rationale: "All three target platforms accept it natively, so one render serves all of them.",
      status: "active",
    },
    daysAgo: 20,
  },
  {
    key: "decision-length",
    kind: "decision",
    title: "Keep shorts between 25 and 45 seconds",
    bodyMd: "",
    tags: ["format", "pacing"],
    data: {
      decision: "Target 25 to 45 seconds per short.",
      rationale: "Long enough for one complete idea, short enough to keep completion rates high.",
      status: "active",
    },
    daysAgo: 18,
  },
  {
    key: "decision-captions",
    kind: "decision",
    title: "Burn captions into every video",
    bodyMd: "",
    tags: ["captions", "accessibility"],
    data: {
      decision: "Captions are burned in, two lines at most, in the brand font.",
      rationale: "Most viewers watch with the sound off, and platform captions vary in quality.",
      status: "active",
    },
    daysAgo: 16,
  },
  {
    key: "decision-brand-colours",
    kind: "decision",
    title: "Use Thread and Ember as the only accent colours",
    bodyMd: "",
    tags: ["brand", "design"],
    data: {
      decision: "Accents are Thread #4a52d1 and Ember #c2552a; everything else is neutral.",
      status: "active",
    },
    daysAgo: 25,
  },
  {
    key: "decision-posting-cadence",
    kind: "decision",
    title: "Post three times a week",
    bodyMd: "",
    tags: ["schedule"],
    data: {
      decision: "Publish on Monday, Wednesday and Friday mornings.",
      rationale: "A cadence we can sustain beats a burst we cannot.",
      status: "active",
    },
    daysAgo: 30,
  },
  {
    key: "decision-music",
    kind: "decision",
    title: "No background music under narration",
    bodyMd: "",
    tags: ["audio"],
    data: {
      decision: "Narrated segments have no music; sound effects only mark transitions.",
      rationale: "Music under speech hurt clarity in every test we ran.",
      status: "active",
    },
    daysAgo: 14,
  },
  {
    key: "note-voice-style",
    kind: "note",
    title: "Narration style guide",
    bodyMd:
      "Second person, present tense, one idea per sentence. Avoid filler such as basically and " +
      "actually. Read the script aloud once before recording.",
    tags: ["voice", "scripts"],
    data: {},
    daysAgo: 11,
  },
  {
    key: "note-hook-patterns",
    kind: "note",
    title: "Hook patterns that worked",
    bodyMd:
      "1. A wrong answer most people give.\n2. A surprising number on screen in the first second.\n" +
      "3. The finished result first, then how it was built.",
    tags: ["hooks"],
    data: {},
    daysAgo: 4,
  },
  {
    key: "note-render-checklist",
    kind: "note",
    title: "Render checklist",
    bodyMd:
      "Check safe areas for captions and buttons, loudness around -14 LUFS, the first frame works as " +
      "a cover, and the last frame does not cut mid-word.",
    tags: ["rendering", "checklist"],
    data: {},
    daysAgo: 13,
  },
  {
    key: "note-topic-backlog",
    kind: "note",
    title: "Topic backlog",
    bodyMd:
      "Hash maps, TCP handshakes, garbage collection, Unicode normalisation, rate limiting, " +
      "consistent hashing, CRDTs, and how HTTPS certificates are checked.",
    tags: ["topics", "planning"],
    data: {},
    daysAgo: 1,
  },
  {
    key: "note-analytics-review",
    kind: "note",
    title: "Weekly analytics review",
    bodyMd:
      "Retention drops at the four-second mark when the hook is a title card. Videos that open on " +
      "motion keep more viewers past ten seconds.",
    tags: ["analytics", "retention"],
    data: {},
    daysAgo: 6,
  },
  {
    key: "note-diagram-style",
    kind: "note",
    title: "Diagram style",
    bodyMd:
      "Rounded boxes, two-pixel strokes, labels in sentence case. Animate arrows in the direction " +
      "data flows and never more than three boxes moving at once.",
    tags: ["design", "diagrams"],
    data: {},
    daysAgo: 22,
  },
  {
    key: "note-glossary",
    kind: "note",
    title: "Glossary of terms we simplify",
    bodyMd:
      "Latency: waiting time. Throughput: how much fits through per second. Idempotent: safe to " +
      "repeat. Race condition: two things finishing in an order nobody planned.",
    tags: ["scripts", "glossary"],
    data: {},
    daysAgo: 27,
  },
  {
    key: "summary-rust-session",
    kind: "session_summary",
    title: "Session summary: Rust ownership script",
    bodyMd:
      "Drafted the script for the Rust ownership short. Settled on the referee metaphor and a 35 " +
      "second runtime. Open question: show lifetimes or leave them for a follow-up.",
    tags: ["rust", "scripts"],
    data: { sessionId: "seed-session-rust" },
    daysAgo: 1,
  },
  {
    key: "summary-series-planning",
    kind: "session_summary",
    title: "Session summary: planning the internals series",
    bodyMd:
      "Picked ten topics from the backlog, ordered from networking basics to distributed systems, " +
      "and agreed to publish them as a numbered series.",
    tags: ["series", "planning"],
    data: { sessionId: "seed-session-series" },
    daysAgo: 5,
  },
  {
    key: "summary-cover-review",
    kind: "session_summary",
    title: "Session summary: cover review",
    bodyMd:
      "Reviewed twelve covers. Kept the high-contrast ones with three words or fewer and redid the " +
      "rest with the brand accents.",
    tags: ["covers", "design"],
    data: { sessionId: "seed-session-covers" },
    daysAgo: 9,
  },
];
