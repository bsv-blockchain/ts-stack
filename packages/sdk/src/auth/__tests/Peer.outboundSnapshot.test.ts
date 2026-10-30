import { Peer } from '../Peer.js'
import { snapshotAuthMessage } from '../AuthMessageValidation.js'
import { AuthMessage, Transport } from '../types.js'
import { PrivateKey } from '../../primitives/index.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'

/**
 * toPeer copies and checks the payload once; the outbound snapshot reuses that
 * private copy instead of checking every byte again. These tests pin what the
 * transport receives and the limits that still apply.
 */
function linkedPeers(
  options?: { maxGeneralPayloadBytes?: number | null },
  senderWallet = new CompletedProtoWallet(new PrivateKey(41))
): { sender: Peer; received: number[][]; sent: AuthMessage[] } {
  const sent: AuthMessage[] = []
  const callbacks: Array<(message: AuthMessage) => Promise<void>> = []
  const transport = (from: number, to: number): Transport => ({
    async send(message) {
      if (from === 0) sent.push(message)
      await callbacks[to](message)
    },
    async onData(callback) {
      callbacks[from] = callback
    }
  })
  const sender = new Peer(
    senderWallet,
    transport(0, 1),
    undefined,
    undefined,
    undefined,
    undefined,
    options
  )
  const receiver = new Peer(
    new CompletedProtoWallet(new PrivateKey(42)),
    transport(1, 0),
    undefined,
    undefined,
    undefined,
    undefined,
    options
  )
  const received: number[][] = []
  receiver.listenForGeneralMessages((_sender, payload) => {
    received.push(payload)
  })
  return { sender, received, sent }
}

describe('Peer outbound general message snapshot', () => {
  test.each([
    ['no payload budget', undefined],
    ['a payload budget', { maxGeneralPayloadBytes: 1024 }],
    ['an unbounded payload', { maxGeneralPayloadBytes: null }]
  ])('sends owned copies with %s', async (_name, options) => {
    const { sender, received, sent } = linkedPeers(options)
    const payload = [1, 2, 3, 255, 0]
    await sender.toPeer(payload)

    const general = sent.find(message => message.messageType === 'general')!
    expect(Object.getPrototypeOf(general)).toBeNull()
    expect(general.payload).toEqual(payload)
    expect(general.payload).not.toBe(payload)
    expect(Array.isArray(general.signature)).toBe(true)
    expect(general.signature!.length).toBeGreaterThan(0)
    expect(received).toEqual([payload])
    payload[0] = 9
    expect(general.payload![0]).toBe(1)
  })

  const change = {
    fill: (data: number[]) => data.fill(7),
    append: (data: number[]) => data.push(7),
    nonByte: (data: number[]) => {
      data[0] = 300
    }
  }
  test.each([
    // [name, when, change, payload budget, error, payloads received, payloads sent]
    ['fills it before signing', 'before', change.fill, undefined, null, [[7, 7, 7]], [[7, 7, 7]]],
    [
      'fills it after signing',
      'after',
      change.fill,
      undefined,
      'Signature is not valid',
      [],
      [[7, 7, 7]]
    ],
    [
      'appends to it after signing',
      'after',
      change.append,
      undefined,
      'Signature is not valid',
      [],
      [[1, 2, 3, 7]]
    ],
    // Without a payload budget only the receiver checks the payload's shape.
    [
      'writes a non-byte after signing',
      'after',
      change.nonByte,
      undefined,
      'general.payload must be a dense byte array',
      [],
      [[300, 2, 3]]
    ],
    // With one the sender rejects it before anything is sent.
    [
      'writes a non-byte after signing, with a payload budget',
      'after',
      change.nonByte,
      { maxGeneralPayloadBytes: 1024 },
      'general.payload must be a dense byte array',
      [],
      []
    ]
  ])(
    'sends what the wallet left in its data array when it %s',
    async (_name, when, mutate, options, error, expected, expectedSent) => {
      const wallet = new CompletedProtoWallet(new PrivateKey(43))
      const createSignature = wallet.createSignature.bind(wallet)
      let enabled = false
      wallet.createSignature = async (args, originator) => {
        const data = args.data as number[]
        if (enabled && when === 'before') mutate(data)
        const result = await createSignature(args, originator)
        if (enabled && when === 'after') mutate(data)
        return result
      }
      const { sender, received, sent: transported } = linkedPeers(options, wallet)
      await sender.toPeer([1])
      received.length = 0
      transported.length = 0
      enabled = true
      const sent = sender.toPeer([1, 2, 3])
      if (error === null) await sent
      else await expect(sent).rejects.toThrow(error)
      expect(received).toEqual(expected)
      expect(transported.map(message => message.payload)).toEqual(expectedSent)
    }
  )

  test('still counts each payload byte toward the message limit without a payload budget', async () => {
    const { sender, sent } = linkedPeers()
    await sender.toPeer([1])
    // Without a payload budget the snapshot counts up to four JSON bytes per payload byte.
    await expect(sender.toPeer(Array.from({ length: 4 * 1024 * 1024 }, () => 1))).rejects.toThrow(
      'Authentication message exceeds the byte limit.'
    )
    expect(sent.filter(message => message.messageType === 'general')).toHaveLength(1)
  }, 60_000)

  test('applies a payload budget before signing', async () => {
    const { sender, received } = linkedPeers({ maxGeneralPayloadBytes: 4 })
    await sender.toPeer([1, 2, 3, 4])
    await expect(sender.toPeer([1, 2, 3, 4, 5])).rejects.toThrow(
      'general.payload must be a dense byte array of at most 4 bytes.'
    )
    expect(received).toEqual([[1, 2, 3, 4]])
  })
})

describe('snapshotAuthMessage general payload shape', () => {
  const message = (payload: unknown): unknown => ({
    version: '0.1',
    messageType: 'general',
    identityKey: new PrivateKey(44).toPublicKey().toString(),
    nonce: Buffer.alloc(32, 1).toString('base64'),
    yourNonce: Buffer.alloc(48, 2).toString('base64'),
    payload,
    signature: [48, 1, 2]
  })

  test.each([
    ['a nested array', [1, [2]]],
    ['a string', [1, '2']],
    ['a non-byte number', [1, 256]]
  ])('rejects a payload containing %s', (_name, payload) => {
    expect(() => snapshotAuthMessage(message(payload))).toThrow(
      'general.payload must be a dense byte array'
    )
    expect(() => snapshotAuthMessage(message(payload), { maxGeneralPayloadBytes: 100 })).toThrow(
      'general.payload must be a dense byte array'
    )
  })

  test.each([
    ['a string', 'abc'],
    ['empty', []]
  ])('rejects a signature that is %s', (_name, signature) => {
    const value = { ...(message([1]) as object), signature }
    expect(() => snapshotAuthMessage(value)).toThrow(
      'general.signature must be a dense byte array of at most 1024 bytes.'
    )
  })

  test('accepts and copies a dense byte payload', () => {
    const payload = [0, 1, 255]
    const snapshot = snapshotAuthMessage(message(payload))
    expect(snapshot.payload).toEqual(payload)
    expect(snapshot.payload).not.toBe(payload)
  })
})
