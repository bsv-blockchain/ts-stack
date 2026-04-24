/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { PeerMessage } from '../../types.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

const WS_URL = 'https://message-box-us-1.bsvb.tech'

let recipientKey: string
const messageBox = 'testBox'
const testMessage = 'Hello, this is a WebSocket integration test.'

const walletClient = new WalletClient('json-api', 'localhost')
const messageBoxClient = new MessageBoxClient({
  host: WS_URL,
  walletClient
})

describe('MessageBoxClient WebSocket Integration Tests', () => {
  beforeAll(async () => {
    const keyResult = await walletClient.getPublicKey({ identityKey: true })
    recipientKey = keyResult.publicKey
    console.log(`Recipient Key: ${recipientKey}`)

    await messageBoxClient.initializeConnection()
  })

  afterAll(async () => {
    console.log('Closing WebSocket connection after tests.')
    await messageBoxClient.disconnectWebSocket()
  })

  /** TEST 1: Authenticate WebSocket Connection **/
  test('should authenticate and connect via WebSocket', async () => {
    expect(messageBoxClient.testSocket).toBeDefined()
    console.log('[TEST] WebSocket authenticated and connected')
  }, 15000)

  /** TEST 2: Join a WebSocket Room **/
  test('should join a WebSocket room successfully', async () => {
    await messageBoxClient.joinRoom(messageBox)
    console.log(`[TEST] Joined WebSocket room: ${messageBox}`)

    const identityKey = await messageBoxClient.getIdentityKey()
    expect(messageBoxClient.getJoinedRooms().has(`${identityKey}-${messageBox}`)).toBe(true)
  }, 15000)

  /** TEST 3: Send and Receive a Message via WebSocket **/
  test('should send and receive a message via WebSocket', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let receivedMessage: PeerMessage | null = null

    const messagePromise = new Promise<PeerMessage>((resolve, reject) => {
      messageBoxClient
        .listenForLiveMessages({
          messageBox,
          onMessage: (message: PeerMessage) => {
            try {
              receivedMessage = message
              console.log('[TEST] Received message:', JSON.stringify(message, null, 2))
              resolve(message)
            } catch (error) {
              console.error('[ERROR] Error processing message:', error)
              reject(error)
            }
          }
        })
        .catch(reject)

      setTimeout(() => {
        reject(new Error('Test timed out: No message received over WebSocket'))
      }, 10000)
    })

    await messageBoxClient.joinRoom(messageBox)

    console.log(`[TEST] Sending message to WebSocket room: ${messageBox}`)

    const response = await messageBoxClient.sendLiveMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage
    })

    expect(response).toHaveProperty('status', 'success')

    const received = await messagePromise
    expect(received).not.toBeNull()
    expect(received.body).toBe(testMessage)
    expect(received.sender).toBe(recipientKey)
  }, 15000)

  /** TEST 4: Leave a WebSocket Room **/
  test('should leave a WebSocket room successfully', async () => {
    await messageBoxClient.leaveRoom(messageBox)
    console.log(`[TEST] Left WebSocket room: ${messageBox}`)

    const identityKey = await messageBoxClient.getIdentityKey()
    expect(messageBoxClient.getJoinedRooms().has(`${identityKey}-${messageBox}`)).toBe(false)
  }, 15000)

  /** TEST 5: Send and Receive a Message via WebSocket without Encryption **/
  test('should send and receive a message via WebSocket without encryption', async () => {
    const unencryptedMessage = 'Plaintext WebSocket message'

    const messagePromise = new Promise<PeerMessage>((resolve, reject) => {
      messageBoxClient
        .listenForLiveMessages({
          messageBox,
          onMessage: (message: PeerMessage) => {
            try {
              console.log('[TEST] Received unencrypted message:', message)
              resolve(message)
            } catch (error) {
              console.error('[ERROR] Error processing message:', error)
              reject(error)
            }
          }
        })
        .catch(reject)

      setTimeout(() => {
        reject(new Error('Test timed out: No unencrypted message received'))
      }, 10000)
    })

    await messageBoxClient.joinRoom(messageBox)

    const response = await messageBoxClient.sendLiveMessage({
      recipient: recipientKey,
      messageBox,
      body: unencryptedMessage,
      skipEncryption: true
    })

    expect(response).toHaveProperty('status', 'success')

    const received = await messagePromise
    expect(received).not.toBeNull()
    expect(received.body).toBe(unencryptedMessage)
    expect(received.sender).toBe(recipientKey)
  }, 15000)
})
