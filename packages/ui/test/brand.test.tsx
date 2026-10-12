// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LoomcastGlyph, LoomcastMark } from "@loomcast/ui/brand";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const brandDir = join(import.meta.dirname, "../../../design/brand");

function drawing(svg: Element) {
  const attrs = (selector: string, names: string[]) =>
    [...svg.querySelectorAll(selector)].map((el) => names.map((name) => el.getAttribute(name)));
  return {
    viewBox: svg.getAttribute("viewBox"),
    paths: attrs("path", ["d", "stroke-width", "stroke-linecap", "stroke-linejoin"]),
    stops: attrs("stop", ["offset", "stop-color"]),
    rects: attrs("rect", ["width", "height", "rx"]),
  };
}

function brandSvg(file: string): Element {
  const source = readFileSync(join(brandDir, file), "utf8");
  return new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
}

describe("LoomcastMark", () => {
  it("draws the same mark as design/brand/loomcast-mark.svg", () => {
    const { container } = render(<LoomcastMark />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg) expect(drawing(svg)).toEqual(drawing(brandSvg("loomcast-mark.svg")));
  });

  it("is labelled by default and can be decorative", () => {
    render(
      <>
        <LoomcastMark />
        <LoomcastMark aria-hidden />
      </>,
    );
    expect(screen.getAllByRole("img", { name: "Loomcast" })).toHaveLength(1);
  });

  it("gives every instance its own gradient and mask ids", () => {
    const { container } = render(
      <>
        <LoomcastMark size={20} />
        <LoomcastMark size={44} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of container.querySelectorAll("[fill^='url('], [stroke^='url('], [mask]")) {
      const ref =
        (el.getAttribute("fill") ?? "") +
        (el.getAttribute("stroke") ?? "") +
        (el.getAttribute("mask") ?? "");
      const id = ref.match(/url\(#([^)]+)\)/)?.[1];
      expect(id && el.closest("svg")?.querySelector(`#${CSS.escape(id)}`)).toBeTruthy();
    }
  });
});

describe("LoomcastGlyph", () => {
  it("draws the same glyph as design/brand/loomcast-glyph.svg", () => {
    const { container } = render(<LoomcastGlyph />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg) expect(drawing(svg)).toEqual(drawing(brandSvg("loomcast-glyph.svg")));
  });

  it("keeps the 24:25 proportions", () => {
    const { container } = render(<LoomcastGlyph size={25} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("25");
  });
});
