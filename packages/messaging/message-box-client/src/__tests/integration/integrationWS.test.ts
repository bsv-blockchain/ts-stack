/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { PeerMessage } from '../../types.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'node:crypto'

;(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

const WS_URL = process.env.MESSAGE_BOX_INTEGRATION_HOST!

let recipientKey: string
/** Set by the test that needs it, so the subscription is made before the send. */
let onDelivery: ((message: PeerMessage) => void) | undefined
const messageBox = 'testBox'
const testMessage = 'Hello, this is a WebSocket integration test.'

const walletClient = new WalletClient('json-api', process.env.MESSAGE_BOX_WALLET_ORIGINATOR!)
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

  /**
   * TEST 6: the deterministic repro, against a real server. Membership belongs
   * to the socket that joined, so a replacement has to join for itself. This
   * used to emit no joinRoom at all, leaving a connected and authenticated
   * socket that was pushed nothing.
   **/
  test('joins its room again on a socket built after a disconnect', async () => {
    await messageBoxClient.disconnectWebSocket()
    expect(messageBoxClient.getJoinedRooms().size).toBe(0)

    const body = 'Message after a fresh socket'
    let received: PeerMessage | undefined
    const delivered = new Promise<PeerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Test timed out: the new socket never received its room message'))
      }, 10000)
      onDelivery = (message: PeerMessage) => {
        clearTimeout(timer)
        received = message
        resolve(message)
      }
    })

    // Awaited: the room is only joined once this resolves.
    await messageBoxClient.listenForLiveMessages({
      messageBox,
      onMessage: (message: PeerMessage) => onDelivery?.(message)
    })

    const identityKey = await messageBoxClient.getIdentityKey()
    expect(messageBoxClient.getJoinedRooms().has(`${identityKey}-${messageBox}`)).toBe(true)

    const response = await messageBoxClient.sendLiveMessage({
      recipient: recipientKey,
      messageBox,
      body,
      skipEncryption: true
    })
    expect(response).toHaveProperty('status', 'success')

    await delivered
    expect(received?.body).toBe(body)
  }, 20000)
})
