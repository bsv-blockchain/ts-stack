import argon2Api from 'hash-wasm/dist/argon2.umd.min.js'
import pbkdf2Api from 'hash-wasm/dist/pbkdf2.umd.min.js'
import sha256Api from 'hash-wasm/dist/sha256.umd.min.js'
import sha512Api from 'hash-wasm/dist/sha512.umd.min.js'

export const argon2id = argon2Api.argon2id
export const pbkdf2 = pbkdf2Api.pbkdf2
export const createSHA256 = sha256Api.createSHA256
export const createSHA512 = sha512Api.createSHA512
