import { AESGCM, AESGCMDecrypt } from '../../primitives/AESGCM'

function expectUint8ArrayEqual(a: Uint8Array, b: Uint8Array): void {
  expect(a).toHaveLength(b.length)

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`mismatch at index ${i}: ${a[i]} !== ${b[i]}`)
    }
  }
}

describe('AESGCM resource-intensive boundary', () => {
  it('handles ciphertext longer than 2^32 bits', () => {
    const key = new Uint8Array(new Array(16).fill(0x01))
    const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    // 2^32 bits = 2^29 bytes. Go just beyond that boundary.
    const bigSizeBytes = (1 << 29) + 16
    const plaintext = new Uint8Array(bigSizeBytes)

    const { result: ciphertext, authenticationTag } = AESGCM(plaintext, iv, key)
    const decrypted = AESGCMDecrypt(ciphertext, iv, authenticationTag, key) as Uint8Array | null

    expect(decrypted).not.toBeNull()
    const decryptedBytes = decrypted as Uint8Array
    expect(decryptedBytes).toHaveLength(bigSizeBytes)
    expectUint8ArrayEqual(decryptedBytes, plaintext)
  })
})
