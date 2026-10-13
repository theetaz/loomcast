import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApprovalsInboxSchema,
  buildPath,
  ChannelSchema,
  CreateChannelRequestSchema,
  CreatePostRequestSchema,
  DRY_RUN_PERMALINK_SCHEME,
  dryRunPermalink,
  ListScheduledTasksQuerySchema,
  MAX_SERIES_CHANNELS,
  PermalinkSchema,
  PUBLISH_ERROR_CODES,
  PublishAttemptSchema,
  PublishErrorSchema,
  PublisherStatusSchema,
  PublishRequestSchema,
  RETRYABLE_PUBLISH_ERROR_CODES,
  ReschedulePostRequestSchema,
  type RouteBody,
  type RouteResponse,
  routes,
  ScheduledPostSchema,
  ScheduledTaskSchema,
  SeriesChannelsSchema,
  type UpdateChannelRequest,
  UpdateChannelRequestSchema,
  UpdateSeriesChannelsRequestSchema,
} from "../src";
import {
  at,
  channel,
  contentItem,
  deadTask,
  fakeSecret,
  ids,
  post,
  publishAttempt,
} from "./fixtures";

describe("channels", () => {
  it("round-trips a channel", () => {
    expect(ChannelSchema.parse(channel)).toEqual(channel);
    expect(
      ChannelSchema.parse({
        ...channel,
        externalId: null,
        username: null,
        parentChannelId: null,
        status: "disconnected",
        connected: false,
        scopes: [],
        tokenExpiresAt: null,
        liveBlocker: "not_connected",
      }).status,
    ).toBe("disconnected");
  });

  it("drops credentials and anything else it does not list", () => {
    const row = {
      ...channel,
      accessToken: fakeSecret("access"),
      refreshToken: fakeSecret("refresh"),
      secretCiphertext: fakeSecret("ciphertext"),
      secretNonce: fakeSecret("nonce"),
      keyVersion: 1,
      meta: { pageAccessToken: fakeSecret("page") },
    };
    const parsed = ChannelSchema.parse(row);

    expect(parsed).toEqual(channel);
    expect(
      Object.keys(ChannelSchema.shape).filter((key) => /token|secret|nonce|key/i.test(key)),
    ).toEqual(["tokenExpiresAt"]);
  });

  it("creates planning channels on known platforms only", () => {
    expect(
      CreateChannelRequestSchema.parse({ platform: "threads", displayName: "  Rust daily " }),
    ).toEqual({ platform: "threads", displayName: "Rust daily" });
    expect(
      CreateChannelRequestSchema.safeParse({ platform: "youtube", displayName: "Rust" }).success,
    ).toBe(false);
    expect(CreateChannelRequestSchema.safeParse({ platform: "x", displayName: " " }).success).toBe(
      false,
    );
  });

  it("updates the name and switches, at least one of them", () => {
    expect(UpdateChannelRequestSchema.safeParse({ dryRun: false }).success).toBe(true);
    expect(UpdateChannelRequestSchema.safeParse({ requiresApproval: true }).success).toBe(true);
    expect(UpdateChannelRequestSchema.safeParse({ displayName: "Rust" }).success).toBe(true);
    expect(UpdateChannelRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateChannelRequestSchema.safeParse({ dryRun: "no" }).success).toBe(false);
    expectTypeOf<UpdateChannelRequest>().toEqualTypeOf<{
      displayName?: string | undefined;
      dryRun?: boolean | undefined;
      requiresApproval?: boolean | undefined;
    }>();
  });

  it("links a series to distinct channels", () => {
    const links = [
      { channelId: ids.channel, enabled: true },
      { channelId: ids.channel2, enabled: false },
    ];

    expect(SeriesChannelsSchema.parse({ seriesId: ids.series, channels: links }).channels).toEqual(
      links,
    );
    expect(UpdateSeriesChannelsRequestSchema.safeParse({ channels: [] }).success).toBe(true);
    expect(
      UpdateSeriesChannelsRequestSchema.safeParse({ channels: [links[0], links[0]] }).success,
    ).toBe(false);
    expect(
      UpdateSeriesChannelsRequestSchema.safeParse({
        channels: Array.from({ length: MAX_SERIES_CHANNELS + 1 }, () => links[0]),
      }).success,
    ).toBe(false);
  });
});

describe("scheduled posts", () => {
  it("round-trips a post with its item summary", () => {
    expect(ScheduledPostSchema.parse(post)).toEqual(post);
    expect(ScheduledPostSchema.safeParse({ ...post, item: undefined }).success).toBe(false);
  });

  it("accepts https and dry-run permalinks only", () => {
    const dryRun = dryRunPermalink("threads", ids.post);

    expect(dryRun).toBe(`dryrun://threads/${ids.post}`);
    expect(dryRun.startsWith(DRY_RUN_PERMALINK_SCHEME)).toBe(true);
    expect(PermalinkSchema.safeParse(dryRun).success).toBe(true);
    expect(PermalinkSchema.safeParse("https://www.instagram.com/reel/abc/").success).toBe(true);
    expect(PermalinkSchema.safeParse("http://www.instagram.com/reel/abc/").success).toBe(false);
    expect(PermalinkSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(
      ScheduledPostSchema.safeParse({
        ...post,
        status: "published",
        permalink: dryRun,
        publishedAt: at,
      }).success,
    ).toBe(true);
  });

  it("creates and reschedules with timestamps", () => {
    const create = { itemId: ids.item, channelId: ids.channel, scheduledAt: post.scheduledAt };

    expect(CreatePostRequestSchema.parse(create)).toEqual(create);
    expect(CreatePostRequestSchema.safeParse({ ...create, scheduledAt: "tomorrow" }).success).toBe(
      false,
    );
    expect(
      ReschedulePostRequestSchema.safeParse({
        scheduledAt: "2026-10-15T13:00:00.000Z",
        expectedUpdatedAt: post.updatedAt,
      }).success,
    ).toBe(true);
    expect(
      ReschedulePostRequestSchema.safeParse({ scheduledAt: "2026-10-15T13:00:00.000Z" }).success,
    ).toBe(false);
  });

  it("lists items waiting for approval and missed posts", () => {
    const inbox = {
      items: [
        {
          item: contentItem,
          deadlineAt: post.scheduledAt,
          posts: [{ ...post, status: "planned", versionId: null, publishMode: "approval" }],
        },
        { item: { ...contentItem, id: ids.entry }, deadlineAt: null, posts: [] },
      ],
      missed: [{ ...post, status: "missed" }],
    };

    expect(ApprovalsInboxSchema.parse(inbox)).toEqual(inbox);
  });
});

describe("publisher", () => {
  const request = {
    platform: "instagram",
    externalId: "17841400000000001",
    videoUrl: "https://media.example.test/renders/final.mp4",
    posterUrl: "https://media.example.test/renders/poster.jpg",
    caption: "The borrow checker in one rule. #rustlang",
    durationMs: 41_000,
    width: 1080,
    height: 1920,
  };

  it("builds a publish request from public https media", () => {
    expect(PublishRequestSchema.parse(request)).toEqual(request);
    expect(PublishRequestSchema.safeParse({ ...request, posterUrl: undefined }).success).toBe(true);
    expect(
      PublishRequestSchema.safeParse({ ...request, videoUrl: "http://media.example.test/a.mp4" })
        .success,
    ).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...request, platform: "youtube" }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...request, durationMs: 0 }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...request, caption: "x".repeat(2_201) }).success).toBe(
      false,
    );
  });

  it("classifies publish errors", () => {
    expect(PUBLISH_ERROR_CODES).toEqual([
      "rate_limited",
      "auth",
      "permission",
      "invalid_media",
      "transient",
      "permanent",
      "not_configured",
    ]);
    expect([...RETRYABLE_PUBLISH_ERROR_CODES]).toEqual(["rate_limited", "transient"]);

    const limited = {
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 60_000,
      platformCode: "4",
      message: "Application request limit reached",
    };
    expect(PublishErrorSchema.parse(limited)).toEqual(limited);
    expect(PublishErrorSchema.safeParse({ ...limited, code: "teapot" }).success).toBe(false);
    expect(PublishErrorSchema.safeParse({ ...limited, retryAfterMs: -1 }).success).toBe(false);
    expect(
      PublishErrorSchema.safeParse({ code: "permanent", retryable: false, message: "" }).success,
    ).toBe(true);
  });

  it("records attempts and reports its switches", () => {
    expect(PublishAttemptSchema.parse(publishAttempt)).toEqual(publishAttempt);
    expect(PublishAttemptSchema.safeParse({ ...publishAttempt, attempt: 0 }).success).toBe(false);
    expect(
      PublisherStatusSchema.parse({ mode: "dry-run", enabled: true, lastTickAt: null }).mode,
    ).toBe("dry-run");
    expect(
      PublisherStatusSchema.safeParse({ mode: "dry_run", enabled: true, lastTickAt: at }).success,
    ).toBe(false);
  });
});

describe("scheduler admin", () => {
  it("lists tasks by status and kind", () => {
    expect(ScheduledTaskSchema.parse(deadTask)).toEqual(deadTask);
    expect(ListScheduledTasksQuerySchema.parse({ status: "dead", limit: "20" })).toEqual({
      status: "dead",
      limit: 20,
    });
    expect(ListScheduledTasksQuerySchema.safeParse({ kind: "system.ping" }).success).toBe(false);
  });
});

describe("calendar and publishing routes", () => {
  const names = Object.keys(routes).filter((name) =>
    /^(channels|calendar|scheduledPosts|approvals|publisher|scheduler)\.|^series\.(setC|c)hannels$/.test(
      name,
    ),
  );

  it("are all session routes under /api", () => {
    expect(names.sort()).toEqual([
      "approvals.inbox",
      "calendar.get",
      "channels.create",
      "channels.disconnect",
      "channels.list",
      "channels.update",
      "publisher.status",
      "scheduledPosts.attempts",
      "scheduledPosts.cancel",
      "scheduledPosts.create",
      "scheduledPosts.reschedule",
      "scheduler.retryTask",
      "scheduler.tasks",
      "series.channels",
      "series.setChannels",
    ]);
    for (const name of names) {
      expect(routes[name as keyof typeof routes].auth, name).toBe("session");
    }
  });

  it("builds their paths", () => {
    expect(buildPath(routes["scheduledPosts.reschedule"].path, { id: ids.post })).toBe(
      `/api/scheduled-posts/${ids.post}`,
    );
    expect(routes["series.setChannels"].method).toBe("PUT");
    expect(buildPath(routes["series.setChannels"].path, { id: ids.series })).toBe(
      `/api/series/${ids.series}/channels`,
    );
    expect(routes["scheduledPosts.create"].status).toBe(201);
    expect(routes["channels.create"].status).toBe(201);
  });

  it("takes channel and series filters as comma-separated ids", () => {
    const query = routes["calendar.get"].query.parse({
      from: "2026-10-12T00:00:00.000Z",
      to: "2026-10-19T00:00:00.000Z",
      channelIds: `${ids.channel},${ids.channel2}`,
      seriesIds: [ids.series],
    });

    expect(query.channelIds).toEqual([ids.channel, ids.channel2]);
    expect(query.seriesIds).toEqual([ids.series]);
    expect(
      routes["calendar.get"].query.safeParse({
        from: "2026-10-12T00:00:00.000Z",
        to: "2026-10-19T00:00:00.000Z",
        channelIds: `${ids.channel},${ids.channel}`,
      }).success,
    ).toBe(false);
  });

  it("derives request and response types", () => {
    expectTypeOf<RouteBody<"scheduledPosts.reschedule">>().toEqualTypeOf<{
      scheduledAt: string;
      expectedUpdatedAt: string;
    }>();
    expectTypeOf<RouteResponse<"calendar.get">["slots"][number]>().toEqualTypeOf<{
      at: string;
      seriesId: string;
      channelId: string;
      postId?: string | undefined;
    }>();
  });
});
