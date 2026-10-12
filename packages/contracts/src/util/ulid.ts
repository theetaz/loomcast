/** Crockford base32, as used by ULIDs. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

/** A ULID: 10 characters of millisecond time followed by 16 random characters. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Fills a byte array with random values. */
export type RandomBytes = (length: number) => Uint8Array;

interface WebCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** Web Crypto is a global in browsers and in Node, but it is not part of the ES library types. */
const webCryptoRandomBytes: RandomBytes = (length) => {
  const { crypto } = globalThis as unknown as { crypto: WebCrypto };
  return crypto.getRandomValues(new Uint8Array(length));
};

/** Creates a ULID. Ids from the same millisecond are unique but not ordered among themselves. */
export function createUlid(
  now: number = Date.now(),
  randomBytes: RandomBytes = webCryptoRandomBytes,
): string {
  let time = Math.floor(now);
  let timePart = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    timePart = ENCODING.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  let randomPart = "";
  for (const byte of randomBytes(RANDOM_LENGTH)) {
    randomPart += ENCODING.charAt(byte % 32);
  }
  return timePart + randomPart;
}
