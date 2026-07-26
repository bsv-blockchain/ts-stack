import { Utils, Random, type WalletProtocol } from '@bsv/sdk'
import { DEFAULT_PROTOCOL, DEFAULT_WINDOW_MS, DEFAULT_CLOCK_SKEW_MS } from './constants.js'
import type {
  AuthProof,
  AuthProofOptions,
  AuthSigData,
  CreateAuthProofArgs,
  RequestBody,
  VerifyAuthProofArgs,
  VerifyAuthProofResult
} from './types.js'

interface ResolvedOptions {
  protocol: WalletProtocol
  windowMs: number
  clockSkewMs: number
}

function resolveOptions(options: AuthProofOptions = {}): ResolvedOptions {
  return {
    protocol: options.protocol ?? DEFAULT_PROTOCOL,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    clockSkewMs: options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
  }
}

/** Canonical bytes both sides hash. Fixed field order; '\n' is a safe delimiter. */
export function serializeAuthSigData(data: AuthSigData): number[] {
  const canonical = [data.action, data.identityKey, String(data.expiresAt), data.nonce].join('\n')
  return Utils.toArray(canonical, 'utf8')
}

/**
 * Reduce a request body to the exact bytes bound into the signature, so the
 * client can pass the value it sends and the verifier the raw body it received:
 * a string is UTF-8, an `ArrayBuffer` or typed array is taken as raw bytes (so
 * binary is preserved), and anything else — a plain object or any array — is
 * JSON-encoded then UTF-8.
 */
export function normalizeBody(body: RequestBody): number[] {
  if (typeof body === 'string') return Utils.toArray(body, 'utf8')
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) {
    return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }
  return Utils.toArray(JSON.stringify(body), 'utf8') // plain objects and all arrays → JSON
}

/**
 * Bytes that are signed and verified for a proof: the canonical auth fields and,
 * when the request carries a body, that body bound in too. The body is appended
 * length-prefixed (not delimited) so arbitrary binary stays unambiguous. With no
 * body the result is exactly `serializeAuthSigData(data)`, so login proofs are
 * byte-for-byte unchanged. A body-bound proof and a bodyless one never collide:
 * an empty body (length 0) still differs from "no body" (nothing appended).
 */
export function serializeSignablePayload(data: AuthSigData, body?: RequestBody): number[] {
  const head = serializeAuthSigData(data)
  if (body === undefined) return head
  const writer = new Utils.Writer()
  writer.write(head)
  const bytes = normalizeBody(body)
  writer.writeVarIntNum(bytes.length)
  writer.write(bytes)
  return writer.toArray()
}

/** Builds the per-request signable data: fresh expiry + strong random nonce. */
export function createAuthSigData(
  action: string,
  identityKey: string,
  options?: AuthProofOptions,
  now: number = Date.now()
): AuthSigData {
  const { windowMs } = resolveOptions(options)
  return {
    action,
    identityKey,
    expiresAt: now + windowMs,
    nonce: Utils.toBase64(Random(32))
  }
}

/** Pure check of shape, action, and freshness. Signature + single-use checked separately. */
export function checkAuthSigData(
  data: AuthSigData | undefined | null,
  expectedAction: string,
  now: number,
  options?: AuthProofOptions
): { valid: boolean; error?: string } {
  const { windowMs, clockSkewMs } = resolveOptions(options)

  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Malformed proof' }
  }
  const { action, identityKey, expiresAt, nonce } = data
  if (
    typeof action !== 'string' ||
    typeof identityKey !== 'string' ||
    identityKey.length === 0 ||
    typeof nonce !== 'string' ||
    nonce.length === 0
  ) {
    return { valid: false, error: 'Malformed proof' }
  }
  if (action !== expectedAction) {
    return { valid: false, error: 'Action mismatch' }
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { valid: false, error: 'Malformed proof' }
  }
  if (now >= expiresAt) {
    return { valid: false, error: 'Proof expired' }
  }
  // Reject expiry beyond the window — stops a client minting a long-lived proof.
  if (expiresAt - now > windowMs + clockSkewMs) {
    return { valid: false, error: 'Proof expiry too far in the future' }
  }
  return { valid: true }
}

/**
 * Client-side: build a signed proof authorizing `action` for this wallet.
 * `counterparty` is the verifier's identity key (e.g. your backend) that the
 * wallet signs toward — relative to the wallet, so it's a different key than the
 * server passes to verify (there the counterparty is this signer's identity).
 *
 * Pass `body` to bind a request payload (e.g. the new username for a profile
 * update) into the signature; the verifier must be given the same body. Omit it
 * for bodyless actions like login. The body is bound only — it is not stored in
 * the returned proof; send it over the wire as usual.
 */
export async function createAuthProof(args: CreateAuthProofArgs): Promise<AuthProof> {
  const { wallet, counterparty, action, body } = args
  const { protocol } = resolveOptions(args)
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  const data = createAuthSigData(action, identityKey, args)

  const { signature } = await wallet.createSignature({
    data: serializeSignablePayload(data, body),
    protocolID: protocol,
    keyID: data.nonce,
    counterparty
  })

  return { data, signature }
}

/**
 * Server-side: verify a proof. Steps: shape/action/freshness → signature →
 * single-use (via the injected `consumeNonce`). Returns the authenticated
 * identityKey on success. `now` is injectable for tests.
 *
 * If the proof was created with a `body`, pass the raw received body as `body`
 * so it is bound into the verified bytes identically; a tampered or missing body
 * then fails the signature check. Omit it for bodyless actions.
 */
export async function verifyAuthProof(args: VerifyAuthProofArgs): Promise<VerifyAuthProofResult> {
  const { wallet, proof, action: expectedAction, consumeNonce, body } = args
  const { protocol } = resolveOptions(args)
  const now = args.now ?? Date.now()

  if (!proof || typeof proof !== 'object' || !proof.data || !Array.isArray(proof.signature)) {
    return { valid: false, error: 'Malformed proof' }
  }

  const shape = checkAuthSigData(proof.data, expectedAction, now, args)
  if (!shape.valid) {
    return { valid: false, error: shape.error }
  }

  const { identityKey, nonce, expiresAt } = proof.data

  // identityKey and signature come from the request; a malformed key or signature
  // can make verification throw, so treat any failure as an invalid signature.
  let signatureValid = false
  try {
    const result = await wallet.verifySignature({
      data: serializeSignablePayload(proof.data, body),
      signature: proof.signature,
      protocolID: protocol,
      keyID: nonce,
      counterparty: identityKey
    })
    signatureValid = result.valid
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' }
  }

  const fresh = await consumeNonce(nonce, new Date(expiresAt))
  if (!fresh) {
    return { valid: false, error: 'Proof already used' }
  }

  return { valid: true, identityKey }
}
