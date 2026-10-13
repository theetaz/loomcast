import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { studioPaths } from "./paths.ts";
import { type CommandRunner, runCommand } from "./process.ts";

// What a render needs on this machine. A browser is looked up the way the HyperFrames CLI does
// (explicit path, then its cache); nothing is downloaded here.

export interface RenderTools {
  ffmpeg: boolean;
  ffprobe: boolean;
  hyperframes: boolean;
  gsap: boolean;
  /** The browser the CLI would use, if one is available without downloading. */
  browser?: string;
  ready: boolean;
}

function cachedHeadlessShell(base: string): string | undefined {
  if (!existsSync(base)) return undefined;
  try {
    const versions = readdirSync(base).filter((name) => !name.startsWith("."));
    return versions.length > 0 ? join(base, versions.sort().at(-1) ?? "") : undefined;
  } catch {
    return undefined;
  }
}

export function findRenderBrowser(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const name of ["PRODUCER_HEADLESS_SHELL_PATH", "HYPERFRAMES_BROWSER_PATH"]) {
    const path = env[name];
    if (path && existsSync(path)) return path;
  }
  const home = homedir();
  return (
    cachedHeadlessShell(join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell")) ??
    cachedHeadlessShell(join(home, ".cache", "puppeteer", "chrome-headless-shell"))
  );
}

async function works(run: CommandRunner, command: string): Promise<boolean> {
  try {
    return (await run(command, ["-version"])).code === 0;
  } catch {
    return false;
  }
}

export async function checkRenderTools(
  options: {
    studioRoot?: string;
    run?: CommandRunner;
    ffmpegPath?: string;
    ffprobePath?: string;
  } = {},
): Promise<RenderTools> {
  const run = options.run ?? runCommand;
  const paths = studioPaths(options.studioRoot);
  const tools = {
    ffmpeg: await works(run, options.ffmpegPath ?? "ffmpeg"),
    ffprobe: await works(run, options.ffprobePath ?? "ffprobe"),
    hyperframes: existsSync(paths.hyperframesBin),
    gsap: existsSync(paths.gsap),
    browser: findRenderBrowser(),
  };
  return {
    ...tools,
    ready: tools.ffmpeg && tools.ffprobe && tools.hyperframes && tools.gsap && !!tools.browser,
  };
}
