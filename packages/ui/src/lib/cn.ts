import { createCn } from "cn/config";

/**
 * Joins class names and resolves Tailwind conflicts, aware of the Loomcast
 * theme. Without these groups a custom size such as `text-body` reads as a
 * text colour and would be dropped next to `text-foreground`.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: ["display", "title", "heading", "body", "control", "small", "mono"],
      shadow: ["card", "pop", "focus"],
      ease: ["sheet"],
    },
    classGroups: {
      duration: [{ duration: ["press", "menu-in", "menu-out", "tabs", "toast-in", "toast-out"] }],
    },
  },
});
