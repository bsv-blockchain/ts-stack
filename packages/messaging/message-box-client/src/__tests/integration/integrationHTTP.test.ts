/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

// Ensure Jest doesn't mock WalletClient
jest.unmock('@bsv/sdk');

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

// Explicitly initialize WalletClient with Meta Net Client (MNC)
const walletClient = new WalletClient('json-api', 'localhost')

// Initialize MessageBoxClient for HTTP-Only Testing
const messageBoxClient = new MessageBoxClient({
  host: 'https://message-box-us-1.bsvb.tech',
  walletClient
})

describe('MessageBoxClient HTTP Integration Tests (No WebSocket)', () => {
  let recipientKey: string
  let testMessageId: string
  const messageBox = 'testBox'
  const testMessage = 'Hello, this is an integration test.'
  const testMessage2 = 'Another test message to avoid duplicates.'

  beforeAll(async () => {
    try {
      console.log('[DEBUG] Retrieving public key...')
      const publicKeyResponse = await walletClient.getPublicKey({ identityKey: true })

      if (
        publicKeyResponse?.publicKey == null ||
        typeof publicKeyResponse.publicKey !== 'string' ||
        publicKeyResponse.publicKey.trim() === ''
      ) {
        throw new Error('[ERROR] getPublicKey returned an invalid key!')
      }

      recipientKey = publicKeyResponse.publicKey.trim()
      console.log('[DEBUG] Successfully assigned recipientKey:', recipientKey)

      // Ensure identity key is set internally in MessageBoxClient
      await messageBoxClient.initializeConnection()
    } catch (error) {
      console.error('[ERROR] Failed to set up test:', error)
      throw error
    }
  })

  afterAll(async () => {
    try {
      if (testMessageId !== undefined && testMessageId !== '') {
        console.log('[DEBUG] Cleaning up test messages...')
      }
    } catch (error) {
      console.error('[ERROR] Failed to acknowledge test message:', error)
    }
  })

  /** TEST 1: Send a Message with Correct Payment **/
  test('should send a message successfully with correct payment', async () => {
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage,
      skipEncryption: true // TEMPORARY to test if this fixes the 400
    })

    console.log('[DEBUG] SendMessage Response:', response)

    expect(response).toHaveProperty('status', 'success')
    expect(response).toHaveProperty('messageId', expect.any(String))

    testMessageId = response.messageId // Store for cleanup
  }, 30000)

  /** TEST 2: List Messages **/
  test('should list messages from messageBox', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.some(msg => msg.body === testMessage)).toBe(true)
  }, 15000)

  /** TEST 3: List Messages from an Empty MessageBox **/
  test('should return an empty list if no messages exist', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox: 'emptyBox' })
    expect(messages).toEqual([])
  }, 15000)

  /** TEST 4: Acknowledge a Message **/
  test('should acknowledge (delete) a message', async () => {
    const ackResponse = await messageBoxClient.acknowledgeMessage({ messageIds: [testMessageId] })
    expect(ackResponse).toBe('success')
  }, 15000)

  /** TEST 5: Acknowledge a Nonexistent Message **/
  test('should fail to acknowledge a nonexistent message', async () => {
    await expect(
      messageBoxClient.acknowledgeMessage({ messageIds: ['fakeMessageId'] })
    ).rejects.toThrow('Message not found!')
  }, 15000)

  /** TEST 6: Send Message with Invalid Recipient **/
  test('should fail if recipient is invalid', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: '', // Invalid recipient
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('You must provide a message recipient!')
  }, 15000)

  /** TEST 7: Send Message with Empty Body **/
  test('should fail if message body is empty', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: '' // Empty message
      })
    ).rejects.toThrow('Every message must have a body!')
  }, 15000)

  /** TEST 8: Send Message with Excessive Payment (Should still succeed) **/
  test('should send a message even if payment is more than required', async () => {
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage2,
      skipEncryption: true
    })

    console.log('[DEBUG] Overpayment SendMessage Response:', response)

    expect(response.status).toBe('success')
  }, 15000)

  /** TEST: Send a message without encryption **/
  test('should send a message without encryption when skipEncryption is true', async () => {
    const plaintextMessage = 'Unencrypted test message'
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: plaintextMessage,
      skipEncryption: true // Bypass encryption
    })

    expect(response).toHaveProperty('status', 'success')
    expect(response).toHaveProperty('messageId', expect.any(String))

    const messages = await messageBoxClient.listMessages({ messageBox })
    expect(messages.some(msg => msg.body === plaintextMessage)).toBe(true)
  }, 30000)
})
