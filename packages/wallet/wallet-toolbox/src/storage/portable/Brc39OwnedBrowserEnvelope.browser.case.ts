import { decryptBrc39OwnedBrowserEnvelope } from './Brc39OwnedBrowserEnvelope'

// Authored UNRUN. Real native WebCrypto only. No substituted native promise is
// used as positive platform qualification; pending-native recovery still needs
// separate actual host lifecycle coverage.
export async function verifyBrowserOwnedSmallEnvelopeAndRefusal(): Promise<void> {
  const raw = new Uint8Array(32).fill(67),
    nonce = new Uint8Array(32).fill(71),
    plain = new TextEncoder().encode('private envelope \u96ea \ud83d\ude00'),
    key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']),
    payload = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain)),
    original = payload.slice(),
    selected = { maximumPayloadBytes: 4096, expiresAt: Date.now() + 120000, cleanupMilliseconds: 30000 }
  const result = await decryptBrc39OwnedBrowserEnvelope(raw, nonce, payload, selected)
  try {
    if (
      result.length !== plain.length ||
      result.some((value, index) => value !== plain[index]) ||
      payload.some((value, index) => value !== original[index]) ||
      raw.some(value => value !== 67)
    )
      throw new Error('Owned whole native GCM source/oracle differs')
  } finally {
    result.fill(0)
  }
  const corrupted = payload.slice()
  corrupted[corrupted.length - 1] ^= 1
  let refused = false
  try {
    const unexpected = await decryptBrc39OwnedBrowserEnvelope(raw, nonce, corrupted, selected)
    unexpected.fill(0)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('Owned whole native GCM admitted corrupt tag')
  const controller = new AbortController()
  controller.abort(new Error('case cancellation'))
  refused = false
  try {
    await decryptBrc39OwnedBrowserEnvelope(raw, nonce, payload, { ...selected, signal: controller.signal })
  } catch {
    refused = true
  }
  if (!refused) throw new Error('Owned whole native GCM admitted cancelled invocation')
  raw.fill(0)
  nonce.fill(0)
  plain.fill(0)
  payload.fill(0)
  corrupted.fill(0)
  original.fill(0)
}
