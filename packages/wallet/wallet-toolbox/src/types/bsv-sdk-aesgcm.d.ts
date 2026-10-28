declare module '@bsv/sdk/primitives/AESGCM' {
  export function multiply(block0: Uint8Array, block1: Uint8Array): Uint8Array
  export function ghash(input: Uint8Array, hashSubKey: Uint8Array): Uint8Array
  export function AESGCM(
    plainText: Uint8Array,
    initializationVector: Uint8Array,
    key: Uint8Array
  ): {
    result: Uint8Array
    authenticationTag: Uint8Array
  }

  export function AESGCMDecrypt(
    cipherText: Uint8Array,
    initializationVector: Uint8Array,
    authenticationTag: Uint8Array,
    key: Uint8Array
  ): Uint8Array | null
}
