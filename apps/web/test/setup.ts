import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { installBrowserStubs } from "./support/browser-stubs";
import { server } from "./support/server";

installBrowserStubs();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  server.events.removeAllListeners();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
