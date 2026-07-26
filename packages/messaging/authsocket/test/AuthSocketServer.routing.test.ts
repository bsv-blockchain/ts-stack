import { AuthSocketServer } from '../src/AuthSocketServer.js'

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

  it('broadcasts with authenticated routing context and reports send failures', async () => {
    const error = new Error('send failed')
    const authenticatedPeer = { toPeer: jest.fn().mockResolvedValue(undefined) }
    const failingPeer = { toPeer: jest.fn().mockRejectedValue(error) }
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const server = Object.create(AuthSocketServer.prototype) as any
    server.peers = new Map([
      ['authenticated', { peer: authenticatedPeer, identityKey: 'recipient' }],
      ['failing', { peer: failingPeer, identityKey: 'recipient' }]
    ])

    server.emit('broadcast-event', { value: 1 })
    expect(server.emitToIdentity('recipient', 'private-event', { value: 2 })).toBe(2)
    await new Promise(resolve => setImmediate(resolve))

    expect(authenticatedPeer.toPeer).toHaveBeenCalledWith(expect.any(Array), 'recipient')
    expect(consoleError).toHaveBeenCalledWith(error)
    consoleError.mockRestore()
  })
})
