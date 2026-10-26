import { WORKSPACE_ICON_MAX_BYTES, type WorkspaceIconMime } from "@loomcast/contracts";

/**
 * The image type `body` really is, from its first bytes, or null when it is not a PNG, JPEG or
 * WebP. The declared type is never trusted: the icon is served back with this type.
 */
export function sniffIconMime(body: Uint8Array): WorkspaceIconMime | null {
  const starts = (bytes: readonly number[], offset = 0) =>
    body.byteLength >= offset + bytes.length &&
    bytes.every((byte, index) => body[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // "RIFF" <size> "WEBP"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** Why an image cannot be a workspace icon, or null when it can. */
export function iconProblem(body: Uint8Array): string | null {
  if (body.byteLength === 0) {
    return "The image is empty.";
  }
  if (body.byteLength > WORKSPACE_ICON_MAX_BYTES) {
    return `The image is larger than ${WORKSPACE_ICON_MAX_BYTES / 1024} KB.`;
  }
  if (sniffIconMime(body) === null) {
    return "Use a PNG, JPEG or WebP image.";
  }
  return null;
}
