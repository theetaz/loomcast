// @vitest-environment jsdom
import {
  applyTheme,
  initTheme,
  readThemePreference,
  resolveTheme,
  setThemePreference,
  THEME_STORAGE_KEY,
  themeInitScript,
  useTheme,
} from "@loomcast/ui/lib/theme";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "./support/match-media";

const DARK = "(prefers-color-scheme: dark)";
const root = document.documentElement;

let media: ReturnType<typeof installMatchMedia>;

beforeEach(() => {
  window.localStorage.clear();
  root.className = "";
  root.removeAttribute("style");
  media = installMatchMedia({ [DARK]: false });
  initTheme();
  for (const pause of document.head.querySelectorAll("style[data-theme-switch]")) pause.remove();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("theme preference", () => {
  it("defaults to system and ignores unknown stored values", () => {
    expect(readThemePreference()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");
  });

  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("stores explicit choices and forgets system", () => {
    setThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");

    setThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.classList.contains("dark")).toBe(false);
  });
});

describe("applyTheme", () => {
  it("switches with transitions disabled until the next frame", () => {
    vi.useFakeTimers();
    applyTheme("dark");

    const pause = document.head.querySelector<HTMLStyleElement>("style[data-theme-switch]");
    expect(pause?.textContent).toContain("transition:none!important");
    expect(root.classList.contains("dark")).toBe(true);

    vi.runAllTimers();
    expect(document.head.querySelector("style[data-theme-switch]")).toBeNull();
  });

  it("does nothing when the theme is already applied", () => {
    applyTheme("dark");
    const before = document.head.querySelectorAll("style[data-theme-switch]").length;
    applyTheme("dark");
    expect(document.head.querySelectorAll("style[data-theme-switch]").length).toBe(before);
  });
});

describe("useTheme", () => {
  function ThemeProbe() {
    const { preference, resolvedTheme, setPreference } = useTheme();
    return (
      <button type="button" onClick={() => setPreference("dark")}>
        {preference}:{resolvedTheme}
      </button>
    );
  }

  it("follows the OS while the preference is system", () => {
    render(<ThemeProbe />);
    expect(screen.getByRole("button").textContent).toBe("system:light");

    act(() => media.set(DARK, true));
    expect(screen.getByRole("button").textContent).toBe("system:dark");
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("updates every consumer when the preference changes", () => {
    render(<ThemeProbe />);
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button").textContent).toBe("dark:dark");

    act(() => media.set(DARK, false));
    expect(screen.getByRole("button").textContent).toBe("dark:dark");
  });
});

describe("themeInitScript", () => {
  it("applies the stored theme before the app loads", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(themeInitScript)();
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
  });
});
