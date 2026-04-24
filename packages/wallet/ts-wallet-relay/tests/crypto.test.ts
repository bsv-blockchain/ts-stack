import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { encryptEnvelope, decryptEnvelope } from '../src/shared/crypto.js'
import { PROTOCOL_ID } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWallet() {
  return new ProtoWallet(PrivateKey.fromRandom())
}

async function identityKey(wallet: ProtoWallet): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return publicKey
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('encryptEnvelope / decryptEnvelope', () => {
  const SESSION_ID = 'test-session-abc123'

  it('mobile encrypts → backend decrypts the original plaintext', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()

    const mobilePub = await identityKey(mobile)
    const backendPub = await identityKey(backend)

    const original = JSON.stringify({
      id: 'req-1',
      seq: 1,
      method: 'pairing_approved',
      params: { mobileIdentityKey: mobilePub, walletMeta: {} },
    })

    const ciphertext = await encryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
      original
    )

    const recovered = await decryptEnvelope(
      backend,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: mobilePub },
      ciphertext
    )

    expect(recovered).toBe(original)
  })

  it('backend encrypts → mobile decrypts (bidirectional ECDH)', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()

    const mobilePub = await identityKey(mobile)
    const backendPub = await identityKey(backend)

    const rpcRequest = JSON.stringify({
      id: 'req-2',
      seq: 2,
      method: 'getPublicKey',
      params: { identityKey: true },
    })

    const ciphertext = await encryptEnvelope(
      backend,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: mobilePub },
      rpcRequest
    )

    const recovered = await decryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
      ciphertext
    )

    expect(recovered).toBe(rpcRequest)
  })

  it('ciphertext is base64url (no +, /, or = characters)', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()
    const backendPub = await identityKey(backend)

    const ciphertext = await encryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
      'hello'
    )

    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('different session IDs (keyIDs) produce different ciphertexts for the same plaintext', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()
    const backendPub = await identityKey(backend)

    const plain = 'same plaintext'
    const params = { protocolID: PROTOCOL_ID, keyID: '', counterparty: backendPub }

    const ct1 = await encryptEnvelope(mobile, { ...params, keyID: 'session-1' }, plain)
    const ct2 = await encryptEnvelope(mobile, { ...params, keyID: 'session-2' }, plain)

    expect(ct1).not.toBe(ct2)
  })
})

describe('interceptor: third wallet cannot decrypt', () => {
  const SESSION_ID = 'test-session-xyz789'

  it('interceptor wallet gets an error — cannot read message content', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()
    const interceptor = makeWallet()

    const mobilePub = await identityKey(mobile)
    const backendPub = await identityKey(backend)
    // interceptor has their own unrelated key pair

    const secret = JSON.stringify({ method: 'getPublicKey', params: { identityKey: true } })

    // Mobile encrypts to backend
    const ciphertext = await encryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
      secret
    )

    // Interceptor tries to decrypt by presenting themselves as the recipient
    // and claiming the sender is mobile — the ECDH shared secret won't match
    await expect(
      decryptEnvelope(
        interceptor,
        { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: mobilePub },
        ciphertext
      )
    ).rejects.toThrow()
  })

  it('interceptor cannot decrypt even if they know the mobile public key', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()
    const interceptor = makeWallet()

    const mobilePub = await identityKey(mobile)
    const backendPub = await identityKey(backend)

    const secret = 'private wallet seed phrase would go here'

    const ciphertext = await encryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
      secret
    )

    // Interceptor tries every plausible counterparty — both mobile and backend keys
    // Neither decryption succeeds because the ECDH requires the backend private key
    await expect(
      decryptEnvelope(
        interceptor,
        { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: mobilePub },
        ciphertext
      )
    ).rejects.toThrow()

    await expect(
      decryptEnvelope(
        interceptor,
        { protocolID: PROTOCOL_ID, keyID: SESSION_ID, counterparty: backendPub },
        ciphertext
      )
    ).rejects.toThrow()
  })

  it('decryption with a wrong session ID also fails', async () => {
    const mobile = makeWallet()
    const backend = makeWallet()

    const mobilePub = await identityKey(mobile)
    const backendPub = await identityKey(backend)

    const ciphertext = await encryptEnvelope(
      mobile,
      { protocolID: PROTOCOL_ID, keyID: 'real-session', counterparty: backendPub },
      'secret data'
    )

    // Correct wallets but wrong keyID — derived key won't match
    await expect(
      decryptEnvelope(
        backend,
        { protocolID: PROTOCOL_ID, keyID: 'wrong-session', counterparty: mobilePub },
        ciphertext
      )
    ).rejects.toThrow()
  })
})
