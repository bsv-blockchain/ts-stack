import { AuthSocketServerOptions } from '../src/AuthSocketServer.js'
import { AsyncSessionManager, PeerSession, WalletInterface } from '@bsv/sdk'

class SharedAsyncSessionManager implements AsyncSessionManager {
  async addSession(_session: PeerSession): Promise<void> {}
  async updateSession(_session: PeerSession): Promise<void> {}
  async getSession(_identifier: string): Promise<PeerSession | undefined> {
    return undefined
  }
  async removeSession(_session: PeerSession): Promise<void> {}
  async hasSession(_identifier: string): Promise<boolean> {
    return false
  }
  async claimMessageNonce(_sessionNonce: string, _messageNonce: string): Promise<boolean> {
    return true
  }
  async claimInitialRequestNonce(_identityKey: string, _initialNonce: string): Promise<boolean> {
    return true
  }
}

describe('AuthSocketServerOptions', () => {
  it('accepts an async session manager for horizontally scaled servers', () => {
    const sessionManager = new SharedAsyncSessionManager()
    const options: AuthSocketServerOptions = {
      wallet: {} as WalletInterface,
      sessionManager
    }

    expect(options.sessionManager).toBe(sessionManager)
  })
})
