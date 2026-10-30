import { jest } from '@jest/globals'

import {
  copyAuthByteArray,
  snapshotAuthMessage,
  snapshotBoundedAuthData,
  snapshotOutboundAuthMessage
} from '../AuthMessageValidation.js'
import { Peer } from '../Peer.js'
import { AuthMessage, Transport } from '../types.js'
import { PrivateKey } from '../../primitives/index.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'

const generalMessage = (payload: number[], signature = [48, 1, 2]): AuthMessage => ({
  version: '0.1',
  messageType: 'general',
  identityKey: new PrivateKey(51).toPublicKey().toString(),
  nonce: Buffer.alloc(32, 1).toString('base64'),
  yourNonce: Buffer.alloc(48, 2).toString('base64'),
  payload,
  signature
})

function countDescriptorReads<T>(run: () => T): { result: T; reads: number } {
  const spy = jest.spyOn(Object, 'getOwnPropertyDescriptor')
  try {
    const result = run()
    return { result, reads: spy.mock.calls.length }
  } finally {
    spy.mockRestore()
  }
}

describe('snapshotOutboundAuthMessage', () => {
  test.each([undefined, null, 4096])(
    'copies owned byte arrays without reading each element (budget %s)',
    budget => {
      const payload = copyAuthByteArray(
        Array.from({ length: 2000 }, () => 5),
        'payload',
        4096,
        true
      )
      const signature = copyAuthByteArray([48, 1, 2], 'signature', 1024)
      const message = generalMessage(payload, signature)
      const owned = countDescriptorReads(() =>
        snapshotOutboundAuthMessage(message, new Set([payload, signature]), budget)
      )
      const checked = countDescriptorReads(() =>
        snapshotOutboundAuthMessage(message, new Set(), budget)
      )
      expect(owned.reads).toBeLessThan(100)
      expect(checked.reads).toBeGreaterThan(2000)
      expect(owned.result).toEqual(checked.result)
      expect(owned.result.payload).not.toBe(payload)
      expect(owned.result.signature).not.toBe(signature)
    }
  )

  test('without a payload budget snapshots any bounded data, as snapshotBoundedAuthData does', () => {
    const bytes = [1, 2]
    const value = { a: bytes }
    expect(snapshotOutboundAuthMessage(value, new Set([bytes]))).toEqual(
      snapshotBoundedAuthData(value)
    )
    expect(() => snapshotAuthMessage(value)).toThrow()
  })

  test('counts owned bytes toward the message limit exactly as checked bytes', () => {
    // { payload } is 10 bytes for the key plus 4 per byte and 2 for the array:
    // 4,194,301 bytes reach the 16 MiB limit exactly and one more exceeds it.
    for (const [length, accepted] of [
      [4_194_301, true],
      [4_194_302, false]
    ] as const) {
      const payload = Array.from({ length }, () => 1)
      const value = { payload }
      const run = (owned: Set<unknown>) => () => snapshotOutboundAuthMessage(value, owned)
      if (accepted) {
        expect(run(new Set())).not.toThrow()
        expect(run(new Set([payload]))).not.toThrow()
      } else {
        expect(run(new Set())).toThrow('Authentication message exceeds the byte limit.')
        expect(run(new Set([payload]))).toThrow('Authentication message exceeds the byte limit.')
      }
    }
  }, 60_000)
})

describe('Peer.toPeer payload checks', () => {
  test('reads each payload element once, not once per copy', async () => {
    const callbacks: Array<(message: AuthMessage) => Promise<void>> = []
    const transport = (from: number, to: number): Transport => ({
      async send(message) {
        await callbacks[to](message)
      },
      async onData(callback) {
        callbacks[from] = callback
      }
    })
    const sender = new Peer(new CompletedProtoWallet(new PrivateKey(52)), transport(0, 1))
    const receiver = new Peer(new CompletedProtoWallet(new PrivateKey(53)), transport(1, 0))
    receiver.listenForGeneralMessages(() => {})
    await sender.toPeer([1])

    const payload = Array.from({ length: 5000 }, () => 3)
    const spy = jest.spyOn(Object, 'getOwnPropertyDescriptor')
    let senderReads = 0
    try {
      // Count only up to the moment the message leaves the sender.
      callbacks[1] = (original => async (message: AuthMessage) => {
        senderReads = spy.mock.calls.length
        await original(message)
      })(callbacks[1])
      await sender.toPeer(payload)
    } finally {
      spy.mockRestore()
    }
    expect(senderReads).toBeGreaterThan(5000)
    expect(senderReads).toBeLessThan(7500)
  })
})
