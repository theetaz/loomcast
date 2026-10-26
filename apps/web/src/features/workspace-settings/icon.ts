import { WORKSPACE_ICON_MAX_BYTES, WORKSPACE_ICON_MIMES } from "@loomcast/contracts";

/** Icons are stored as squares this many pixels wide. */
export const ICON_SIZE = 256;

/** Why an image can't become the icon, in words for the person who picked it. */
export class IconImageError extends Error {}

export function isIconMime(type: string): boolean {
  return (WORKSPACE_ICON_MIMES as readonly string[]).includes(type);
}

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/**
 * The image as a `ICON_SIZE`² PNG, cropped to its centre square, as base64 for
 * `workspaces.setIcon`. Resizing here keeps uploads small and strips anything the original
 * carried besides pixels.
 */
export async function squareIcon(file: Blob): Promise<{ mime: "image/png"; data: string }> {
  if (!isIconMime(file.type)) throw new IconImageError("Choose a PNG, JPEG or WebP image.");
  let image: Drawable;
  try {
    image = await decode(file);
  } catch {
    throw new IconImageError("Couldn't read that image. Try another file.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new IconImageError("This browser can't resize images.");
    const side = Math.min(image.width, image.height);
    if (!(side > 0)) throw new IconImageError("Couldn't read that image. Try another file.");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image.source,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      ICON_SIZE,
      ICON_SIZE,
    );
    const url = canvas.toDataURL("image/png");
    const data = url.slice(url.indexOf(",") + 1);
    if (Math.floor((data.length * 3) / 4) > WORKSPACE_ICON_MAX_BYTES) {
      throw new IconImageError("The icon is too large. Try a simpler image.");
    }
    return { mime: "image/png", data };
  } finally {
    image.release();
  }
}
