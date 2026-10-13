// @vitest-environment jsdom
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@loomcast/ui/components/command";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  // cmdk measures the list and scrolls the active item into view; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function Menu({ onSelect = () => {} }: { onSelect?: (value: string) => void }) {
  return (
    <CommandDialog open title="Jump to" description="Pages and actions">
      <CommandInput placeholder="Search" />
      <CommandList>
        <CommandEmpty>Nothing found</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem value="home" onSelect={onSelect}>
            Home
          </CommandItem>
          <CommandItem value="settings" onSelect={onSelect}>
            Settings
            <CommandShortcut>G S</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

const selected = () =>
  screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");

describe("CommandDialog", () => {
  it("is a named dialog with a combobox and grouped options", () => {
    render(<Menu />);
    const dialog = screen.getByRole("dialog", { name: "Jump to" });
    const describedBy = dialog.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Pages and actions");
    expect(screen.getByRole("combobox").getAttribute("placeholder")).toBe("Search");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Home",
      "SettingsG S",
    ]);
    expect(screen.getByText("Pages")).toBeTruthy();
  });

  it("never animates in or out", () => {
    render(<Menu />);
    const content = document.querySelector<HTMLElement>("[data-slot=command-dialog-content]");
    const overlay = document.querySelector<HTMLElement>("[data-slot=command-dialog-overlay]");
    for (const element of [content, overlay]) {
      expect(element).not.toBeNull();
      expect(element?.className).not.toMatch(/animate-|transition|duration-/);
    }
    for (const option of screen.getAllByRole("option")) {
      expect(option.className).not.toMatch(/transition|duration-/);
    }
  });

  it("moves through the options with the arrow keys and runs one with Enter", () => {
    const onSelect = vi.fn();
    render(<Menu onSelect={onSelect} />);
    const input = screen.getByRole("combobox");

    expect(selected()?.textContent).toBe("Home");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()?.textContent).toContain("Settings");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("filters as you type and shows the empty state", () => {
    render(<Menu />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "sett" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "SettingsG S",
    ]);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing found")).toBeTruthy();
  });
});
