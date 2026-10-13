import { setupServer } from "msw/node";

/** One MSW server for every test file; each test installs handlers over its own mock db. */
export const server = setupServer();
