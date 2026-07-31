import { jest } from '@jest/globals'

import { Peer } from '../Peer.js'
import { AuthMessage, Transport } from '../types.js'
import { PrivateKey } from '../../primitives/index.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'

describe('Peer handshake callback boundary', () => {
  test('registers and cleans the initial-response waiter around a synchronous send failure', async () => {
    let peer: Peer
    const transport: Transport = {
      async send(message) {
        if (message.messageType === 'initialRequest') {
          expect((peer as any).onInitialResponseReceivedCallbacks.size).toBe(2)
          throw new Error('synchronous transport failure')
        }
      },
      async onData(_callback: (message: AuthMessage) => Promise<void>) {}
    }
    peer = new Peer(new CompletedProtoWallet(new PrivateKey(30)), transport)
    await peer.ready
    void (peer as any).waitForInitialResponse('unrelated-session')

    await expect(
      peer.getAuthenticatedSession(new PrivateKey(31).toPublicKey().toString())
    ).rejects.toThrow('synchronous transport failure')
    expect((peer as any).onInitialResponseReceivedCallbacks.size).toBe(1)
    expect(
      Array.from((peer as any).onInitialResponseReceivedCallbacks.values())[0].sessionNonce
    ).toBe('unrelated-session')
    ;(peer as any).stopListeningForInitialResponsesByNonce('unrelated-session')
    expect((peer as any).onInitialResponseReceivedCallbacks.size).toBe(0)
  })

  test('does not leak a waiter when transport send rejects asynchronously', async () => {
    const transport: Transport = {
      send: jest.fn(async () => await Promise.reject(new Error('asynchronous transport failure'))),
      async onData(_callback: (message: AuthMessage) => Promise<void>) {}
    }
    const peer = new Peer(new CompletedProtoWallet(new PrivateKey(32)), transport)
    await peer.ready

    await expect(
      peer.getAuthenticatedSession(new PrivateKey(33).toPublicKey().toString())
    ).rejects.toThrow('asynchronous transport failure')
    expect((peer as any).onInitialResponseReceivedCallbacks.size).toBe(0)
  })
})
