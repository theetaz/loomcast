import { KB_SNIPPET_MATCH_END as END, KB_SNIPPET_MATCH_START as START } from "@loomcast/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Snippet } from "@/lib/snippet";

describe("snippet highlighting", () => {
  it("wraps sentinel-marked matches in mark elements", () => {
    const { container } = render(
      <Snippet text={`…open on the ${START}error${END}, not the ${START}fix${END}…`} />,
    );
    const marks = [...container.querySelectorAll("mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(["error", "fix"]);
    expect(container.textContent).toBe("…open on the error, not the fix…");
  });

  it("shows markup in stored text as text instead of rendering it", () => {
    const hostile = `<img src=x onerror="alert(1)"> ${START}<b>bold</b>${END} <script>bad()</script>`;
    const { container } = render(<Snippet text={hostile} />);
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("<b>bold</b>");
    expect(container.textContent).toBe(
      `<img src=x onerror="alert(1)"> <b>bold</b> <script>bad()</script>`,
    );
  });

  it("tolerates unbalanced sentinels and never shows them", () => {
    const { container } = render(<Snippet text={`${END}tail ${START}open`} />);
    expect(container.textContent).toBe("tail open");
    expect(container.querySelector("mark")?.textContent).toBe("open");
  });
});
