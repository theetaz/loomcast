import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "@/features/conversation/Markdown";

describe("assistant markdown", () => {
  it("renders GitHub-flavoured markdown", () => {
    const { container } = render(
      <Markdown
        text={[
          "**Bold** and `inline`",
          "",
          "- one",
          "- two",
          "",
          "| Beat | Seconds |",
          "|---|---|",
          "| Hook | 5 |",
          "",
          "~~gone~~ https://loomcast.prabhavalabs.com",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("strong")).toHaveTextContent("Bold");
    expect(container.querySelector("code")).toHaveTextContent("inline");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toHaveTextContent("Hook");
    expect(container.querySelector("del")).toHaveTextContent("gone");
    const link = screen.getByRole("link", { name: "https://loomcast.prabhavalabs.com" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("cannot inject HTML", () => {
    const { container } = render(
      <Markdown
        text={[
          '<img src="x" onerror="alert(1)">',
          "",
          "<script>alert(2)</script>",
          "",
          'Inline <b onclick="alert(3)">bold</b> and <iframe src="https://example.com"></iframe>',
          "",
          "[click](javascript:alert(4)) ![pixel](https://tracker.example/pixel.gif)",
        ].join("\n")}
      />,
    );

    for (const tag of ["img", "script", "b", "iframe"]) {
      expect(container.querySelector(tag)).toBeNull();
    }
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
    // The markup shows as the text it is.
    expect(container).toHaveTextContent('<img src="x" onerror="alert(1)">');
    expect(container).toHaveTextContent("<script>alert(2)</script>");
    // Unsafe link targets are dropped; images become plain links.
    expect(screen.getByText("click").closest("a")?.getAttribute("href") ?? "").not.toMatch(
      /javascript/i,
    );
    expect(screen.getByRole("link", { name: "pixel" })).toHaveAttribute(
      "href",
      "https://tracker.example/pixel.gif",
    );
  });

  it("shows code blocks in mono with a copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { container } = render(
      <Markdown text={["```rust", 'let title = String::from("Loomcast");', "```"].join("\n")} />,
    );

    const pre = container.querySelector("pre");
    expect(pre).toHaveClass("font-mono");
    expect(pre).toHaveTextContent('let title = String::from("Loomcast");');
    expect(screen.getByText("rust")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith('let title = String::from("Loomcast");');
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
