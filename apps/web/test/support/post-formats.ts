import type { Channel, ContentItem, ContentVersion, PostFormat } from "@loomcast/contracts";
import { mockChannel } from "@/mocks/calendar";
import { mockComposedItem, mockMedia } from "@/mocks/content";
import { createMockDb, MOCK_USER, type MockDb, mockProject } from "@/mocks/db";
import { mockUploads } from "@/mocks/uploads";
import { onlineStudio } from "./kb";

const CREATED = "2026-10-01T08:00:00.000Z";

/**
 * A signed-in db with one project and three channels: Instagram and Threads (active), and a
 * disabled Facebook Page. Composed items can be added with `compose`.
 */
export function postSetup(options: { facebook?: boolean } = {}) {
  const project = mockProject({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });
  const instagram = mockChannel({
    platform: "instagram",
    displayName: "@rustin60",
    status: "active",
    createdAt: CREATED,
  });
  const threads = mockChannel({
    platform: "threads",
    displayName: "Rust threads",
    status: "active",
    createdAt: CREATED,
  });
  const facebook = mockChannel({
    platform: "facebook",
    displayName: "Rust in 60 seconds",
    status: options.facebook ? "active" : "disabled",
    createdAt: CREATED,
  });
  const channels: Channel[] = [instagram, threads, facebook];
  const db: MockDb = createMockDb({
    signedIn: true,
    projects: [project],
    devices: [onlineStudio()],
    channels,
  });

  const compose = (
    title: string,
    format: PostFormat,
    state: ContentItem["state"],
    types: ("image" | "video")[],
    caption: string | null = null,
  ): { item: ContentItem; version: ContentVersion } => {
    const { item, versions } = mockComposedItem({
      projectId: project.id,
      title,
      format,
      state,
      createdBy: MOCK_USER.id,
      createdAt: CREATED,
      updatedAt: CREATED,
      media: mockMedia(types, (index) => `Alt text of photo ${index + 1}`),
      caption,
    });
    db.contentItems.push(item);
    db.contentVersions.push(...versions);
    return { item, version: versions.at(-1) as ContentVersion };
  };

  return { db, project, channels: { instagram, threads, facebook }, compose };
}

/**
 * An `XMLHttpRequest` stand-in for presigned PUTs: it reports the upload done, tells the mock
 * store the bytes arrived and answers 200.
 */
export class StorageXhr {
  static sent: StorageXhr[] = [];
  static db: MockDb | null = null;

  method = "";
  url = "";
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader() {}

  send() {
    StorageXhr.sent.push(this);
    queueMicrotask(() => {
      const id = this.url.split("/").at(-1) ?? "";
      if (StorageXhr.db) mockUploads(StorageXhr.db).add(id);
      this.status = 200;
      this.onload?.();
    });
  }

  abort() {
    this.onabort?.();
  }

  static reset(db: MockDb | null = null) {
    StorageXhr.sent = [];
    StorageXhr.db = db;
  }
}

/** A small file of `type` with distinct bytes, so each one hashes differently. */
export function photo(name: string, seed = 1, type = "image/png"): File {
  const bytes = Uint8Array.from({ length: 512 }, (_, index) => (index * seed + seed) % 251);
  return new File([bytes], name, { type });
}
