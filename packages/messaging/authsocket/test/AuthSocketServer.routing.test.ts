import { AuthSocketServer } from '../src/AuthSocketServer'

describe('AuthSocketServer identity routing', () => {
  it('delivers only to peers whose BRC-103 identity matches', () => {
    const matchingPeer = { toPeer: jest.fn().mockResolvedValue(undefined) }
    const otherPeer = { toPeer: jest.fn().mockResolvedValue(undefined) }
    const unauthenticatedPeer = { toPeer: jest.fn().mockResolvedValue(undefined) }
    const server = Object.create(AuthSocketServer.prototype) as any
    server.peers = new Map([
      ['matching', { peer: matchingPeer, identityKey: 'recipient' }],
      ['other', { peer: otherPeer, identityKey: 'someone-else' }],
      ['pending', { peer: unauthenticatedPeer, identityKey: undefined }]
    ])

    const selected = server.emitToIdentity('recipient', 'private-event', {
      messageId: 'message-1'
    })

    expect(selected).toBe(1)
    expect(matchingPeer.toPeer).toHaveBeenCalledWith(expect.any(Array), 'recipient')
    expect(otherPeer.toPeer).not.toHaveBeenCalled()
    expect(unauthenticatedPeer.toPeer).not.toHaveBeenCalled()
  })
})
