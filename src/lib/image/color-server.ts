import "server-only";
// M10c: photos.color backfill on the server — decode the 512 px JPEG thumb the Curator already
// holds as base64 with sharp and run the same pure dominantColor() the browser uses at upload.
// Never logs the colour (user data derived from a photo).
import sharp from "sharp";
import { dominantColor } from "./color";

/** A thumb is ≤ 512 px; refuse anything absurd before decoding. */
const MAX_INPUT_PIXELS = 4096 * 4096;

/** base64 JPEG → "#rrggbb", or null when it can't be decoded. Never throws. */
export async function colorFromThumbBase64(thumbBase64: string): Promise<string | null> {
  try {
    const input = Buffer.from(thumbBase64, "base64");
    if (input.length === 0) return null;
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) return null;
    return dominantColor(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3);
  } catch {
    return null;
  }
}
