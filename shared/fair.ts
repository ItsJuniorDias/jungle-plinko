/**
 * Provably fair core — shared by the server (which decides outcomes) and the
 * browser (which lets the player verify them). Uses Web Crypto, available in
 * both Node 18+ and every modern browser.
 *
 * Scheme (same family as the industry-standard Stake/Spribe approach):
 *   bytes  = HMAC_SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}:${round}`)
 *   float  = b0/256 + b1/256² + b2/256³ + b3/256⁴   (4 bytes → one float in [0, 1))
 * Each HMAC round yields 8 floats; more rounds are generated as needed.
 *
 * The server publishes sha256(serverSeed) BEFORE any bet. When the player
 * rotates seeds, the old serverSeed is revealed so every past bet can be checked.
 */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSeed(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

export async function generateFloats(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  count: number,
): Promise<number[]> {
  const floats: number[] = [];
  for (let round = 0; floats.length < count; round++) {
    const bytes = await hmacSha256(serverSeed, `${clientSeed}:${nonce}:${round}`);
    for (let i = 0; i < 32 && floats.length < count; i += 4) {
      floats.push(
        bytes[i] / 256 + bytes[i + 1] / 256 ** 2 + bytes[i + 2] / 256 ** 3 + bytes[i + 3] / 256 ** 4,
      );
    }
  }
  return floats;
}
