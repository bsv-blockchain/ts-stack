/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'
import { expect, test, describe, beforeAll } from '@jest/globals'

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

const walletClient = new WalletClient('json-api', 'https://message-box-us-1.bsvb.tech')
const messageBoxClient = new MessageBoxClient({
  host: 'https://message-box-us-1.bsvb.tech',
  walletClient,
  enableLogging: true,
  networkPreset: 'local'
})

let identityKey: string

describe('Encryption Integration Tests', () => {
  const messageBox = 'testBox'
  const plaintext = 'This is a secure test message.'

  beforeAll(async () => {
    const result = await walletClient.getPublicKey({ identityKey: true })
    identityKey = result.publicKey

    await messageBoxClient.initializeConnection()
  })

  test('encrypts and decrypts a message to self successfully', async () => {
    // Encrypt
    const { ciphertext } = await walletClient.encrypt({
      plaintext: Array.from(new TextEncoder().encode(plaintext)),
      protocolID: [1, 'messagebox'],
      keyID: '1',
      counterparty: 'self'
    })

    expect(Array.isArray(ciphertext)).toBe(true)
    expect(ciphertext.length).toBeGreaterThan(0)

    // Decrypt
    const { plaintext: decryptedBytes } = await walletClient.decrypt({
      ciphertext,
      protocolID: [1, 'messagebox'],
      keyID: '1',
      counterparty: 'self'
    })

    const decrypted = new TextDecoder().decode(Uint8Array.from(decryptedBytes))
    expect(decrypted).toBe(plaintext)
  })

  test('sends and receives encrypted message using MessageBoxClient', async () => {
    // Send message to self
    const sendResult = await messageBoxClient.sendMessage({
      recipient: identityKey,
      messageBox,
      body: plaintext
    })

    expect(sendResult.status).toBe('success')
    expect(typeof sendResult.messageId).toBe('string')

    // List and decrypt
    const messages = await messageBoxClient.listMessages({ messageBox })
    const last = messages.at(-1)

    expect(last).toBeDefined()
    expect(last?.body).toBe(plaintext)
  })

  test('encrypted message is not stored or transmitted as plaintext', async () => {
    // Send encrypted message to self
    const sendResult = await messageBoxClient.sendMessage({
      recipient: identityKey,
      messageBox,
      body: plaintext
    })

    expect(sendResult.status).toBe('success')

    // Manually fetch raw HTTP response
    const fetch = await messageBoxClient.authFetch.fetch(
      'https://message-box-us-1.bsvb.tech/listMessages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageBox })
      }
    )

    const raw = await fetch.json()
    const rawBody = raw.messages.at(-1)?.body

    expect(typeof rawBody).toBe('string')
    const parsed = JSON.parse(rawBody)
    expect(typeof parsed.encryptedMessage).toBe('string')
    expect(parsed.encryptedMessage.includes(plaintext)).toBe(false)
  })
})
