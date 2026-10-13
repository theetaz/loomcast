import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { installBrowserStubs } from "./support/browser-stubs";
import { server } from "./support/server";

installBrowserStubs();

// The first render of a file loads lazy route chunks, which can exceed the 1 s default on a busy machine.
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
