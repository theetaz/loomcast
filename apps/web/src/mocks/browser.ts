import { setupWorker } from "msw/browser";
import { createMockDb, demoSeed } from "./db";
import { createHandlers, createStreamHandler } from "./handlers";

const SESSION_KEY = "loomcast-mock-session";

/**
 * Starts the mock API in the browser for `vite --mode mock`. The demo data
 * resets on reload; the session survives it in sessionStorage, like a cookie.
 */
export async function startMockApi() {
  const db = createMockDb({
    ...demoSeed(),
    signedIn: sessionStorage.getItem(SESSION_KEY) === "1",
    onSessionChange: (signedIn) => {
      if (signedIn) sessionStorage.setItem(SESSION_KEY, "1");
      else sessionStorage.removeItem(SESSION_KEY);
    },
  });
  const worker = setupWorker(...createHandlers(db), createStreamHandler(db));
  await worker.start({ onUnhandledFrame: "bypass", quiet: true });
}
