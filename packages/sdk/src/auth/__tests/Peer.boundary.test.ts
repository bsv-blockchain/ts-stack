import { jest } from '@jest/globals'

import { Peer } from '../Peer.js'
import { AuthMessage, Transport } from '../types.js'
import { PrivateKey } from '../../primitives/index.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'
import { SessionManager } from '../SessionManager.js'

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

  test('removes the exact failed session after the initial send rejects', async () => {
    const failure = new Error('transport failed after session allocation')
    const transport: Transport = {
      async send() {
        throw failure
      },
      async onData(_callback: (message: AuthMessage) => Promise<void>) {}
    }
    const sessions = new SessionManager()
    const removeSession = jest.spyOn(sessions, 'removeSession')
    const peer = new Peer(
      new CompletedProtoWallet(new PrivateKey(34)),
      transport,
      undefined,
      sessions
    )
    await peer.ready

    await expect(
      peer.getAuthenticatedSession(new PrivateKey(35).toPublicKey().toString())
    ).rejects.toBe(failure)
    expect(removeSession).toHaveBeenCalledTimes(1)
    expect(removeSession.mock.calls[0]![0]).toMatchObject({ isAuthenticated: false })
  })

  test('does not remove an absent failed session', async () => {
    const removeSession = jest.fn(async () => {})
    const sessions = {
      addSession: jest.fn(async () => {}),
      updateSession: jest.fn(async () => {}),
      getSession: jest.fn(async () => undefined),
      removeSession,
      hasSession: jest.fn(async () => false),
      claimMessageNonce: jest.fn(async () => true),
      claimInitialRequestNonce: jest.fn(async () => true)
    }
    const transport: Transport = {
      async send() {
        throw new Error('transport failed without persisted session')
      },
      async onData(_callback: (message: AuthMessage) => Promise<void>) {}
    }
    const peer = new Peer(
      new CompletedProtoWallet(new PrivateKey(36)),
      transport,
      undefined,
      sessions
    )
    await peer.ready

    await expect(
      peer.getAuthenticatedSession(new PrivateKey(37).toPublicKey().toString())
    ).rejects.toThrow('transport failed without persisted session')
    expect(removeSession).not.toHaveBeenCalled()
  })
})
