import { BookOpenIcon } from "lucide-react";
import { guidePages } from "@/features/guide/pages";
import { rankByMatch } from "../match";
import type { PaletteItem, PaletteSource } from "../types";

/** The guide's pages, once the user types: "pair", "offline", "deploy". */
export const source: PaletteSource = {
  id: "guide",
  heading: "Guide",
  order: 45,
  icon: BookOpenIcon,
  useItems: ({ query }) => {
    if (query === "") return [];
    const items: (PaletteItem & { keywords?: readonly string[] })[] = guidePages.map((page) => ({
      id: `guide:${page.slug}`,
      label: page.title,
      icon: BookOpenIcon,
      href: `/guide/${page.slug}`,
      secondary: page.summary,
      meta: "Guide",
      recentDetail: "Guide",
      keywords: ["guide", "help", "docs", ...(page.keywords ?? [])],
    }));
    return rankByMatch(items, query, (item) => ({ label: item.label, keywords: item.keywords }));
  },
};
