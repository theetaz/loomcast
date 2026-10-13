import {
  type ApiError,
  type Conversation,
  CreateConversationSchema,
  DEFAULT_PAGE_LIMIT,
  type JobSummary,
  MAX_PAGE_LIMIT,
  type Message,
  PostMessageRequestSchema,
  routes,
  TERMINAL_JOB_STATUSES,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { type MockDb, mockId, publish } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

function isTerminal(job: JobSummary): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status);
}

function byActivity(a: Conversation, b: Conversation): number {
  return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

export function mockConversation(
  overrides: Partial<Conversation> & Pick<Conversation, "projectId" | "createdBy">,
): Conversation {
  return {
    id: mockId(),
    title: null,
    deviceId: null,
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
    ...overrides,
  };
}

export function mockMessage(
  overrides: Partial<Message> & Pick<Message, "conversationId" | "role" | "content">,
): Message {
  return {
    id: mockId(),
    authorUserId: null,
    jobId: null,
    clientMessageId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function mockJob(
  overrides: Partial<JobSummary> & Pick<JobSummary, "projectId" | "conversationId">,
): JobSummary {
  return {
    id: mockId(),
    type: "producer.chat",
    status: "queued",
    claimedByDevice: null,
    attempt: 0,
    maxAttempts: 1,
    error: null,
    createdAt: new Date().toISOString(),
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

/** Changes a job and publishes `job.updated`, like the bridge hub does on every transition. */
export function updateJob(db: MockDb, id: string, patch: Partial<JobSummary>): JobSummary | null {
  const index = db.jobs.findIndex((job) => job.id === id);
  const current = db.jobs[index];
  if (!current) return null;
  const job = { ...current, ...patch };
  db.jobs[index] = job;
  publish(db, { type: "job.updated", payload: { job } });
  return job;
}

/** Stores a message, moves its conversation up and publishes `conversation.message.created`. */
export function storeMessage(db: MockDb, message: Message) {
  db.messages.push(message);
  const conversation = db.conversations.find((item) => item.id === message.conversationId);
  if (conversation) conversation.lastMessageAt = message.createdAt;
  publish(db, { type: "conversation.message.created", payload: { message } });
}

// The pretend producer ------------------------------------------------------

const running = new Map<string, ReturnType<typeof setTimeout>[]>();

function studioDevice(db: MockDb) {
  return db.devices.find((device) => device.online && device.revokedAt === null);
}

function replyFor(prompt: string): string {
  const topic = prompt.trim().replace(/\s+/g, " ").slice(0, 60);
  return [
    `Here's a first pass for **${topic}**. It keeps one idea per beat so it fits in 60 seconds.`,
    "",
    "1. **Hook (0–5 s).** Open on the bug, not the fix: the compiler error on screen.",
    "2. **Context (5–20 s).** One sentence on why it happens, with the line highlighted.",
    "3. **Fix (20–45 s).** Change the code live and run it again.",
    "4. **Payoff (45–60 s).** The rule to remember, as a single caption.",
    "",
    "```rust",
    "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {",
    "    if x.len() > y.len() { x } else { y }",
    "}",
    "```",
    "",
    "| Beat | Seconds | On screen |",
    "|---|---|---|",
    "| Hook | 5 | Error message |",
    "| Fix | 25 | Editor, caret on `'a` |",
    "",
    "Want me to turn this into a full script with captions?",
  ].join("\n");
}

function chunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

/**
 * Plays a `producer.chat` job through the states the real system goes
 * through, publishing the same live events. Waits while no studio agent is
 * online; `resumeQueuedJobs` picks the job up when one connects. A prompt
 * containing "[fail]" fails, to show the error state.
 */
export function runProducer(db: MockDb, jobId: string) {
  const job = db.jobs.find((item) => item.id === jobId);
  const device = studioDevice(db);
  if (!job || !device || running.has(jobId) || job.status !== "queued") return;
  const prompt = db.messages.find((message) => message.jobId === jobId)?.content.text ?? "";

  const timers: ReturnType<typeof setTimeout>[] = [];
  running.set(jobId, timers);
  let at = 0;
  const step = (delay: number, action: () => void) => {
    at += delay;
    timers.push(
      setTimeout(() => {
        const current = db.jobs.find((item) => item.id === jobId);
        if (!current || isTerminal(current)) return stop();
        if (current.cancelRequestedAt) {
          updateJob(db, jobId, { status: "cancelled", finishedAt: new Date().toISOString() });
          return stop();
        }
        action();
      }, at),
    );
  };
  const stop = () => {
    for (const timer of running.get(jobId) ?? []) clearTimeout(timer);
    running.delete(jobId);
  };
  const activity = (kind: string, summary: string) =>
    publish(db, { type: "job.activity", payload: { jobId, kind, summary } });

  step(500, () =>
    updateJob(db, jobId, {
      status: "dispatched",
      claimedByDevice: device.id,
      dispatchedAt: new Date().toISOString(),
    }),
  );
  step(450, () => {
    updateJob(db, jobId, { status: "running", startedAt: new Date().toISOString() });
    activity("Read", "Reading PROJECT.md");
  });
  step(1_100, () => activity("Grep", "Searching scripts/ for earlier hooks"));

  if (prompt.includes("[fail]")) {
    step(900, () => {
      updateJob(db, jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: {
          code: "producer_not_authenticated",
          message: "Log in to the producer runtime on this Mac, then try again.",
          retryable: false,
        },
      });
      stop();
    });
    return;
  }

  const reply = replyFor(prompt);
  step(900, () => activity("Write", "Drafting the reply"));
  for (const chunk of chunks(reply)) {
    step(40, () =>
      publish(db, {
        type: "conversation.message.delta",
        payload: { conversationId: job.conversationId ?? "", jobId, text: chunk },
      }),
    );
  }
  step(300, () => {
    storeMessage(
      db,
      mockMessage({
        conversationId: job.conversationId ?? "",
        role: "assistant",
        jobId,
        content: { text: reply },
      }),
    );
    const conversation = db.conversations.find((item) => item.id === job.conversationId);
    if (conversation) conversation.deviceId = device.id;
    updateJob(db, jobId, { status: "succeeded", finishedAt: new Date().toISOString() });
    stop();
  });
}

/** Runs the jobs that waited for a studio agent. */
export function resumeQueuedJobs(db: MockDb) {
  if (!db.simulateProducer) return;
  for (const job of db.jobs) {
    if (job.status === "queued" && job.type === "producer.chat") runProducer(db, job.id);
  }
}

// Handlers --------------------------------------------------------------------

/** Conversation, message and job routes, following `@loomcast/contracts`. */
export function createConversationHandlers(db: MockDb) {
  const findConversation = (id: string) => db.conversations.find((item) => item.id === id);
  const notFound = () => apiError(404, "not_found", "No conversation has that id.");

  return [
    http.get(path("conversations.list"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const projectId = String(params.projectId);
      if (!db.projects.some((project) => project.id === projectId)) {
        return apiError(404, "not_found", "No project has that id.");
      }
      const items = db.conversations.filter((item) => item.projectId === projectId);
      return HttpResponse.json({ items: [...items].sort(byActivity) });
    }),

    http.post(path("conversations.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const projectId = String(params.projectId);
      if (!db.projects.some((project) => project.id === projectId)) {
        return apiError(404, "not_found", "No project has that id.");
      }
      const parsed = CreateConversationSchema.safeParse(await request.json().catch(() => ({})));
      if (!parsed.success) return apiError(400, "validation_failed", "Check the title.");
      const conversation = mockConversation({
        projectId,
        createdBy: db.user.id,
        title: parsed.data.title ?? null,
      });
      db.conversations.push(conversation);
      return HttpResponse.json(conversation, { status: 201 });
    }),

    http.get(path("conversations.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const conversation = findConversation(String(params.id));
      return conversation ? HttpResponse.json(conversation) : notFound();
    }),

    // Oldest first; the cursor is the offset of the next page.
    http.get(path("messages.list"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const id = String(params.id);
      if (!findConversation(id)) return notFound();
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const limit = Math.min(
        MAX_PAGE_LIMIT,
        Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_LIMIT) || DEFAULT_PAGE_LIMIT,
      );
      const all = db.messages
        .filter((message) => message.conversationId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const items = all.slice(offset, offset + limit);
      const next = offset + limit;
      return HttpResponse.json({ items, nextCursor: next < all.length ? String(next) : null });
    }),

    http.post(path("messages.post"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const conversation = findConversation(String(params.id));
      if (!conversation) return notFound();
      const parsed = PostMessageRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return apiError(400, "validation_failed", "Check the message.");
      const { text, clientMessageId } = parsed.data;

      const existing = db.messages.find(
        (message) =>
          message.conversationId === conversation.id && message.clientMessageId === clientMessageId,
      );
      if (existing) {
        const job = db.jobs.find(
          (item) => item.conversationId === conversation.id && item.createdAt >= existing.createdAt,
        );
        if (job) return HttpResponse.json({ message: existing, job }, { status: 201 });
      }

      const job = mockJob({ projectId: conversation.projectId, conversationId: conversation.id });
      const message = mockMessage({
        conversationId: conversation.id,
        role: "user",
        authorUserId: db.user.id,
        clientMessageId,
        jobId: job.id,
        content: { text },
        createdAt: job.createdAt,
      });
      db.jobs.push(job);
      storeMessage(db, message);
      publish(db, { type: "job.updated", payload: { job } });
      if (db.simulateProducer) runProducer(db, job.id);
      return HttpResponse.json({ message, job }, { status: 201 });
    }),

    http.get(path("jobs.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const job = db.jobs.find((item) => item.id === String(params.id));
      return job ? HttpResponse.json(job) : apiError(404, "not_found", "No job has that id.");
    }),

    // Queued jobs stop at once; running ones stop at the studio agent's next step.
    http.post(path("jobs.cancel"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const job = db.jobs.find((item) => item.id === String(params.id));
      if (!job) return apiError(404, "not_found", "No job has that id.");
      if (isTerminal(job)) return HttpResponse.json(job);
      const now = new Date().toISOString();
      const updated =
        job.status === "queued"
          ? updateJob(db, job.id, { status: "cancelled", cancelRequestedAt: now, finishedAt: now })
          : updateJob(db, job.id, { cancelRequestedAt: now });
      return HttpResponse.json(updated);
    }),
  ];
}

/** Two conversations for the first demo project, so mock mode opens on a real thread. */
export function demoConversations(
  projectId: string,
  userId: string,
  now: number,
): Pick<MockDb, "conversations" | "messages" | "jobs"> {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const ownership = mockConversation({
    projectId,
    createdBy: userId,
    title: "Ownership in one minute",
    createdAt: at(40),
    lastMessageAt: at(12),
  });
  const ideas = mockConversation({
    projectId,
    createdBy: userId,
    title: "Series ideas",
    createdAt: at(3 * 24 * 60),
    lastMessageAt: at(3 * 24 * 60 - 5),
  });
  const firstJob = mockJob({
    projectId,
    conversationId: ownership.id,
    status: "succeeded",
    createdAt: at(14),
    finishedAt: at(12),
  });
  const ideasJob = mockJob({
    projectId,
    conversationId: ideas.id,
    status: "succeeded",
    createdAt: at(3 * 24 * 60),
    finishedAt: at(3 * 24 * 60 - 5),
  });

  const messages: Message[] = [
    mockMessage({
      conversationId: ownership.id,
      role: "user",
      authorUserId: userId,
      jobId: firstJob.id,
      clientMessageId: mockId(),
      createdAt: at(14),
      content: {
        text: "Draft a 60-second short on Rust ownership. One example, no jargon in the first 10 seconds.",
      },
    }),
    mockMessage({
      conversationId: ownership.id,
      role: "assistant",
      jobId: firstJob.id,
      createdAt: at(12),
      content: {
        text: [
          "Here's a script built around a single `String` that moves.",
          "",
          '**Hook (0–8 s)**: *"This line compiles. Add one more and Rust refuses. Here\'s why."*',
          "",
          "```rust",
          'let title = String::from("Loomcast");',
          "let moved = title;",
          'println!("{title}"); // error[E0382]: borrow of moved value',
          "```",
          "",
          "**Explain (8–40 s)**",
          "- Every value has exactly one owner.",
          "- Assigning a `String` moves it; the old name is no longer valid.",
          "- Borrow with `&title` when you only need to read it.",
          "",
          "**Payoff (40–60 s)**: fix it with `let moved = &title;` and run it again.",
          "",
          "| Beat | Seconds | Caption |",
          "|---|---|---|",
          "| Hook | 8 | One owner. Always. |",
          "| Explain | 32 | Move, then borrow |",
          "| Payoff | 20 | `&` reads without taking |",
        ].join("\n"),
      },
    }),
    mockMessage({
      conversationId: ideas.id,
      role: "user",
      authorUserId: userId,
      jobId: ideasJob.id,
      clientMessageId: mockId(),
      createdAt: at(3 * 24 * 60),
      content: { text: "Give me five ideas for the next shorts in this series." },
    }),
    mockMessage({
      conversationId: ideas.id,
      role: "assistant",
      jobId: ideasJob.id,
      createdAt: at(3 * 24 * 60 - 5),
      content: {
        text: [
          "1. `Option` instead of null, in one match",
          "2. Why `&str` and `String` both exist",
          "3. `?` versus `unwrap()`",
          "4. Iterators that beat a `for` loop",
          "5. Lifetimes, drawn as arrows",
        ].join("\n"),
      },
    }),
  ];

  return { conversations: [ownership, ideas], messages, jobs: [firstJob, ideasJob] };
}
