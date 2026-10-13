const OS_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

const MAC_ARCHES: Record<string, string> = {
  arm64: "Apple silicon",
  x64: "Intel",
};

/** `darwin-arm64` reads as `macOS · Apple silicon`; anything unknown is shown as sent. */
export function formatPlatform(platform: string): string {
  const [os = "", arch = ""] = platform.split("-", 2);
  const name = OS_NAMES[os];
  if (!name) return platform;
  const detail = os === "darwin" ? (MAC_ARCHES[arch] ?? arch) : arch;
  return detail ? `${name} · ${detail}` : name;
}

/** Milliseconds left as `m:ss`, never below `0:00`. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
