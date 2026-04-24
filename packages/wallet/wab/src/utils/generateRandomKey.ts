/**
 * Generate a random 256-bit key as a 64-char hex string
 */
export function generateRandomPresentationKey(): string {
    // Node has crypto module; we can do random bytes of length 32 => 256 bits
    return [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
