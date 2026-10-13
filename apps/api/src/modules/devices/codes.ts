import { randomBytes } from "node:crypto";
import { PAIRING_CODE_ALPHABET } from "@loomcast/contracts";
import { sha256Hex } from "../../lib/crypto";

const CODE_CHARS = 8;
const GROUP_CHARS = 4;

// Each random byte picks a character with `byte % 32`; 256 is a multiple of 32, so no character
// is more likely than another.
if (256 % PAIRING_CODE_ALPHABET.length !== 0) {
  throw new Error("The pairing-code alphabet must divide 256 for an unbiased code");
}

/** A new pairing code, `XXXX-XXXX` over `PAIRING_CODE_ALPHABET` (40 bits of entropy). */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let code = "";
  for (const [index, byte] of bytes.entries()) {
    if (index === GROUP_CHARS) {
      code += "-";
    }
    code += PAIRING_CODE_ALPHABET.charAt(byte % PAIRING_CODE_ALPHABET.length);
  }
  return code;
}

/**
 * The stored form of a code. Callers pass the normalised code (trimmed, upper case), which is what
 * `PairingCodeValueSchema` produces, so a code typed in lower case still matches.
 */
export function hashPairingCode(code: string): string {
  return sha256Hex(`pairing:${code}`);
}
