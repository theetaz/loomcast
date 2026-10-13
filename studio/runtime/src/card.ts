import {
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  parse,
  parseFragment,
  serializeOuter,
} from "parse5";
import { escapeHtml, escapeRichText, guardRawText } from "./html.ts";
import type { CardSlot } from "./registry.ts";

// Library cards are standalone compositions: the root sits in <body>, styles live in <head> and
// GSAP comes from a <script src>. Mounting one into a video is a mechanical transform into the
// HyperFrames sub-composition form: everything the render needs goes inside a <template>, the
// parent page provides GSAP and the style tokens, slot text is filled (escaped), and every id is
// prefixed so the same card can appear twice and cards never collide with each other.

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

export interface MountCardInput {
  /** The card's standalone HTML. */
  html: string;
  /** The composition id the mounted copy gets; must be unique within the video. */
  compositionId: string;
  slots: readonly CardSlot[];
  /** Slot text by slot name. Unfilled text slots are emptied; image slots keep their placeholder. */
  values: Readonly<Record<string, string>>;
}

export interface MountedCard {
  html: string;
  compositionId: string;
  width: number;
  height: number;
}

function isElement(node: { nodeName: string }): node is Element {
  return "tagName" in node;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

function setAttr(element: Element, name: string, value: string): void {
  const existing = element.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else element.attrs.push({ name, value });
}

function children(node: ParentNode): ChildNode[] {
  const content = (node as DefaultTreeAdapterTypes.Template).content;
  return node.nodeName === "template" && content ? content.childNodes : node.childNodes;
}

function* walk(node: ParentNode): Generator<Element> {
  for (const child of children(node)) {
    if (isElement(child)) {
      yield child;
      yield* walk(child);
    }
  }
}

function textOf(element: Element): string {
  return element.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
}

function detach(node: ChildNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const list = children(parent);
  const index = list.indexOf(node);
  if (index >= 0) list.splice(index, 1);
  node.parentNode = null;
}

function setInnerHtml(element: Element, html: string): void {
  const fragment = parseFragment(html);
  for (const child of fragment.childNodes) child.parentNode = element;
  element.childNodes = fragment.childNodes;
}

function setText(element: Element, text: string): void {
  element.childNodes = [];
  defaultTreeAdapter.insertText(element, text);
}

/** Ids that look like hex colours are left alone so `#fade` in CSS never changes meaning. */
const HEX_LIKE = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID_REF = /#([A-Za-z_][\w-]*)/g;
const GET_BY_ID = /getElementById\(\s*(["'])([\w-]+)\1\s*\)/g;
const QUOTED_ID = /(["'`])([A-Za-z_][\w-]*)\1/g;

function renameRefs(text: string, ids: ReadonlyMap<string, string>): string {
  return text
    .replace(ID_REF, (match, id: string) => {
      const renamed = ids.get(id);
      return renamed ? `#${renamed}` : match;
    })
    .replace(GET_BY_ID, (match, quote: string, id: string) => {
      const renamed = ids.get(id);
      return renamed ? `getElementById(${quote}${renamed}${quote})` : match;
    });
}

/** Renames quoted strings that are exactly an id: `"t1-w0"` in an id list or a timeline key. */
function renameQuoted(text: string, ids: ReadonlyMap<string, string>): string {
  return text.replace(QUOTED_ID, (match, quote: string, id: string) => {
    const renamed = ids.get(id);
    return renamed ? `${quote}${renamed}${quote}` : match;
  });
}

const BLOCK_TAGS = new Set(["div", "p", "li", "section", "h1", "h2", "h3", "h4"]);

function classes(element: Element): string[] {
  return (attr(element, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** Splits rich text into units, marking those inside `<em>`. Unbalanced markup is plain text. */
function units(value: string, block: boolean, rich: boolean): { text: string; em: boolean }[] {
  const balanced = rich && escapeRichText(value) !== escapeHtml(value);
  const parts = balanced ? value.split(/(<\/?em>)/) : [value];
  const result: { text: string; em: boolean }[] = [];
  let em = false;
  for (const part of parts) {
    if (part === "<em>" || part === "</em>") {
      em = part === "<em>";
      continue;
    }
    const pieces = block ? part.split(/\n+/) : part.split(/\s+/);
    for (const piece of pieces) {
      const text = piece.trim();
      if (text) result.push({ text, em });
    }
  }
  return result;
}

/**
 * Fills one slot element. Most slots hold text (or `<em>` emphasis) and get the escaped value.
 * A few hold a row of identical children, such as one `<span class="word">` per word for a
 * staggered entrance; those are rebuilt one child per word (or per line for block children),
 * keeping the children's tag, class and id sequence so the card's timeline still finds them.
 */
function fillSlot(element: Element, value: string, rich: boolean): void {
  const kids = element.childNodes.filter(isElement);
  const looseText = element.childNodes.some(
    (node) => node.nodeName === "#text" && "value" in node && node.value.trim() !== "",
  );
  const first = kids[0];
  const signature = (kid: Element) =>
    `${kid.tagName}.${classes(kid).filter((name) => name !== "accent")[0] ?? ""}`;
  const uniform =
    first !== undefined &&
    !looseText &&
    first.tagName !== "br" &&
    kids.every((kid) => signature(kid) === signature(first));
  if (!uniform) {
    setInnerHtml(element, rich ? escapeRichText(value) : escapeHtml(value));
    return;
  }

  const block = BLOCK_TAGS.has(first.tagName);
  const pieces =
    kids.length === 1
      ? [{ text: value.replace(/<\/?em>/g, ""), em: false }]
      : units(value, block, rich);
  const baseClass = classes(first).filter((name) => name !== "accent");
  const hasAccent = kids.some((kid) => classes(kid).includes("accent"));
  const ids = kids.map((kid) => attr(kid, "id"));
  const lastId = ids.at(-1);
  const numbered = lastId ? /^(.*?)(\d+)$/.exec(lastId) : null;
  const idFor = (index: number): string | undefined => {
    if (index < ids.length) return ids[index];
    if (!numbered) return undefined;
    return `${numbered[1]}${Number(numbered[2]) + index - ids.length + 1}`;
  };

  const html = pieces
    .map((piece, index) => {
      const names = [...baseClass, ...(piece.em && hasAccent ? ["accent"] : [])];
      const id = idFor(index);
      const text =
        piece.em && !hasAccent ? `<em>${escapeHtml(piece.text)}</em>` : escapeHtml(piece.text);
      const classAttr = names.length ? ` class="${escapeHtml(names.join(" "))}"` : "";
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      return `<${first.tagName}${classAttr}${idAttr}>${text}</${first.tagName}>`;
    })
    .join(" ");
  setInnerHtml(element, html);
}

/** Transforms a standalone library card into a mounted, slot-filled sub-composition. */
export function mountCard(input: MountCardInput): MountedCard {
  const document = parse(input.html);
  const all = [...walk(document)];
  const root = all.find((element) => attr(element, "data-composition-id") !== undefined);
  if (!root) throw new Error("The card has no element with data-composition-id");

  const width = Number(attr(root, "data-width") ?? 1920);
  const height = Number(attr(root, "data-height") ?? 1080);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The card root has an invalid data-width or data-height");
  }

  // Styles anywhere in the document, and inline scripts; external scripts and links are dropped.
  const styles = all.filter((element) => element.tagName === "style");
  const scripts = all.filter(
    (element) => element.tagName === "script" && attr(element, "src") === undefined,
  );
  const beforeFill = new Set(walk(root));
  const rootStyles = new Set(styles.filter((style) => beforeFill.has(style)));
  const headStyles = styles.filter((style) => !rootStyles.has(style));
  for (const script of all.filter((element) => element.tagName === "script")) detach(script);

  // Fill the slots.
  const slotTypes = new Map(input.slots.map((slot) => [slot.name, slot.type]));
  for (const element of [...walk(root)]) {
    const name = attr(element, "data-slot");
    if (name === undefined) continue;
    const type = slotTypes.get(name) ?? "text";
    if (type === "image") continue;
    fillSlot(element, input.values[name] ?? "", type === "richtext");
  }
  const insideRoot = new Set(walk(root));

  // Prefix every id so mounted cards never collide.
  const compositionId = input.compositionId;
  const originalCompositionId = attr(root, "data-composition-id") ?? "";
  const originalRootId = attr(root, "id");
  const ids = new Map<string, string>();
  if (originalRootId) ids.set(originalRootId, compositionId);
  if (originalCompositionId && !HEX_LIKE.test(originalCompositionId)) {
    ids.set(originalCompositionId, compositionId);
  }
  for (const element of [...beforeFill, ...insideRoot]) {
    const id = attr(element, "id");
    if (id && !HEX_LIKE.test(id) && !ids.has(id)) ids.set(id, `${compositionId}--${id}`);
  }
  for (const element of [root, ...insideRoot]) {
    for (const attribute of element.attrs) {
      if (attribute.name === "id") {
        attribute.value = ids.get(attribute.value) ?? attribute.value;
      } else if (attribute.name !== "data-slot") {
        attribute.value = renameRefs(attribute.value, ids);
      }
    }
  }
  setAttr(root, "id", compositionId);
  setAttr(root, "data-composition-id", compositionId);
  setAttr(root, "data-start", "0");

  const rewrite = (text: string) => renameQuoted(renameRefs(text, ids), ids);
  for (const style of styles) {
    if (rootStyles.has(style)) setText(style, guardRawText(rewrite(textOf(style))));
  }

  const css = headStyles.map((style) => rewrite(textOf(style)).trim()).filter(Boolean);
  const js = scripts.map((script) => rewrite(textOf(script)).trim()).filter(Boolean);

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    "  </head>",
    "  <body>",
    `    <template id="${escapeHtml(compositionId)}-template">`,
    ...css.map((text) => `      <style>\n${guardRawText(text)}\n      </style>`),
    `      ${serializeOuter(root)}`,
    ...js.map(
      (text) => `      <script>\n(function () {\n${guardRawText(text)}\n})();\n      </script>`,
    ),
    "    </template>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");

  return { html, compositionId, width, height };
}
