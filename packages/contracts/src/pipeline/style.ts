import { z } from "zod";

// Identifiers from the studio's style library (`studio/style-library/registry.json`). They are
// checked for shape only: the library grows independently, and the studio runtime validates a
// storyboard against the registry it actually has.

export const STYLE_ID_MAX_LENGTH = 64;
export const CARD_ID_MAX_LENGTH = 120;
export const SLOT_NAME_MAX_LENGTH = 40;

/** A style, such as `vox-explainer`: lowercase letters, digits and hyphens. */
export const STYLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A card or template, such as `vox-explainer.t1.section.circle`: lowercase letters, digits, dots,
 * hyphens and underscores, starting with a letter or digit.
 */
export const CARD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** A card's text slot, such as `headline` or `line1`. */
export const SLOT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export const StyleIdSchema = z.string().regex(STYLE_ID_RE, {
  message: "Use a style id such as vox-explainer",
});
export const CardIdSchema = z.string().regex(CARD_ID_RE, {
  message: "Use a card id such as vox-explainer.t1.section.circle",
});
export const SlotNameSchema = z.string().regex(SLOT_NAME_RE, {
  message: "Use a slot name such as headline",
});
