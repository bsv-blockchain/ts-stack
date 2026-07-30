declare module 'hash-wasm/dist/argon2.umd.min.js' {
  import { argon2id } from 'hash-wasm'

  const api: {
    argon2id: typeof argon2id
  }
  export = api
}

declare module 'hash-wasm/dist/pbkdf2.umd.min.js' {
  import { pbkdf2 } from 'hash-wasm'

  const api: {
    pbkdf2: typeof pbkdf2
  }
  export = api
}

declare module 'hash-wasm/dist/sha256.umd.min.js' {
  import { createSHA256 } from 'hash-wasm'

  const api: {
    createSHA256: typeof createSHA256
  }
  export = api
}

declare module 'hash-wasm/dist/sha512.umd.min.js' {
  import { createSHA512 } from 'hash-wasm'

  const api: {
    createSHA512: typeof createSHA512
  }
  export = api
}
