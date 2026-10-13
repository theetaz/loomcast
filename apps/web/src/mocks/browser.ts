import { setupWorker } from "msw/browser";
import { seedAnalyticsDemo } from "./analytics";
import { seedCalendarDemo } from "./calendar";
import { demoContent } from "./content";
import { seedItemDemo } from "./content-item";
import { demoConversations, resumeQueuedJobs } from "./conversations";
import { createMockDb, demoSeed, MOCK_USER, publish } from "./db";
import { seedFormatDemo } from "./formats";
import { createHandlers, createStreamHandler } from "./handlers";
import { demoKb } from "./kb";
import { seedSchedulerDemo } from "./scheduler";
import { demoMembers } from "./users";

const SESSION_KEY = "loomcast-mock-session";

declare global {
  interface Window {
    /** Mock mode only: switches the demo studio agent on and off from the console. */
    loomcastMock?: { setStudioOnline(online: boolean): void };
  }
}

/**
 * Starts the mock API in the browser for `vite --mode mock`. The demo data
 * resets on reload; the session survives it in sessionStorage, like a cookie.
 */
export async function startMockApi() {
  const now = Date.now();
  const seed = demoSeed(now);
  const firstProject = seed.projects?.[0];
  const db = createMockDb({
    ...seed,
    ...(firstProject ? demoConversations(firstProject.id, MOCK_USER.id, now) : {}),
    kbEntries: firstProject ? demoKb(firstProject.id, MOCK_USER.id, now) : [],
    members: demoMembers(now),
    ...demoContent(seed.projects ?? [], MOCK_USER.id, now),
    simulateProducer: true,
    signedIn: sessionStorage.getItem(SESSION_KEY) === "1",
    onSessionChange: (signedIn) => {
      if (signedIn) sessionStorage.setItem(SESSION_KEY, "1");
      else sessionStorage.removeItem(SESSION_KEY);
    },
  });

  seedItemDemo(db, now);
  seedFormatDemo(db);
  seedCalendarDemo(db, now);
  seedAnalyticsDemo(db, now);
  seedSchedulerDemo(db, now);

  window.loomcastMock = {
    setStudioOnline(online) {
      const lastSeenAt = new Date().toISOString();
      for (const device of db.devices) {
        device.online = online;
        device.lastSeenAt = lastSeenAt;
        publish(db, {
          type: "device.status",
          payload: { deviceId: device.id, online, lastSeenAt },
        });
      }
      if (online) resumeQueuedJobs(db);
    },
  };

  const worker = setupWorker(...createHandlers(db), createStreamHandler(db));
  await worker.start({ onUnhandledFrame: "bypass", quiet: true });
}
