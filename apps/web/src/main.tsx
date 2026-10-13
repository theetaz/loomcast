import { initTheme } from "@loomcast/ui/lib/theme";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLiveClient } from "@/lib/live";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "./router";
import "./styles.css";

initTheme();

const queryClient = createQueryClient();
const live = createLiveClient({ queryClient });
const router = createAppRouter({ queryClient, live });

/** `vite --mode mock` answers `/api` in the browser, so the app runs without the API. */
async function startMocks() {
  if (import.meta.env.MODE !== "mock") return;
  const { startMockApi } = await import("./mocks/browser");
  await startMockApi();
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

void startMocks().then(() => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
