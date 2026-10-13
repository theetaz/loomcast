import { themeInitScript } from "@loomcast/ui/lib/theme";
import type { Plugin } from "vite";

const FILE_NAME = "theme-init.js";

/**
 * Sets the theme class before the first paint without an inline script, so the
 * production CSP can stay `script-src 'self'`. The script comes from
 * `@loomcast/ui/lib/theme`, the same module that applies the theme at runtime.
 * It is served in development, emitted next to the bundle in a build, and
 * loaded as a blocking script at the top of <head>.
 */
export function themeInit(): Plugin {
  return {
    name: "loomcast:theme-init",
    configureServer(server) {
      server.middlewares.use(`/${FILE_NAME}`, (_request, response) => {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(themeInitScript);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: FILE_NAME, source: themeInitScript });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: `/${FILE_NAME}` }, injectTo: "head" }];
    },
  };
}
