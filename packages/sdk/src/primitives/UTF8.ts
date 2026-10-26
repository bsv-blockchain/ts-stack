const encoder = new TextEncoder()

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value)
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}
