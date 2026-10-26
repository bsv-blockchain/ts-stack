describe('Express scaffold runtime', () => {
  const originalEnvironment = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnvironment }
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function installMocks() {
    const use = jest.fn()
    const app = { use, locals: {} as Record<string, unknown> }
    const json = jest.fn(() => 'json-middleware')
    const express = Object.assign(
      jest.fn(() => app),
      { json }
    )
    const cors = jest.fn(() => 'cors-middleware')
    const listen = jest.fn((_port: number, _host: string, callback: () => void) => callback())
    const server = { listen }
    const createServer = jest.fn(() => server)
    const fromHex = jest.fn(() => ({ privateKey: true }))
    const ProtoWallet = jest.fn(() => ({ wallet: true }))
    const WalletRelayService = jest.fn(() => ({ relay: true }))

    jest.doMock('express', () => ({ __esModule: true, default: express }))
    jest.doMock('cors', () => ({ __esModule: true, default: cors }))
    jest.doMock('node:http', () => ({ __esModule: true, default: { createServer } }))
    jest.doMock('@bsv/sdk', () => ({
      PrivateKey: { fromHex },
      ProtoWallet
    }))
    jest.doMock('@bsv/wallet-relay', () => ({ WalletRelayService }))

    return {
      app,
      cors,
      createServer,
      express,
      fromHex,
      json,
      listen,
      ProtoWallet,
      use,
      WalletRelayService
    }
  }

  it('requires an explicit stable wallet key before starting a public service', async () => {
    delete process.env['WALLET_PRIVATE_KEY']
    installMocks()
    await expect(import('../template/backend/server.js')).rejects.toThrow(
      'WALLET_PRIVATE_KEY environment variable is required'
    )
  })

  it('starts with public CORS, bounded strict JSON, and the configured wallet', async () => {
    process.env['WALLET_PRIVATE_KEY'] = '11'.repeat(32)
    process.env['PORT'] = '4010'
    delete process.env['ALLOWED_ORIGINS']
    const mocks = installMocks()

    await import('../template/backend/server.js')

    expect(mocks.fromHex).toHaveBeenCalledWith('11'.repeat(32))
    expect(mocks.ProtoWallet).toHaveBeenCalledWith({ privateKey: true })
    expect(mocks.cors).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Desktop-Token']
      })
    )
    expect(mocks.json).toHaveBeenCalledWith({ limit: '64kb', strict: true })
    expect(mocks.use).toHaveBeenCalledTimes(2)
    expect(mocks.createServer).toHaveBeenCalledWith(mocks.app)
    expect(mocks.WalletRelayService).toHaveBeenCalledWith(
      expect.objectContaining({
        app: mocks.app,
        allowedOrigins: undefined,
        wallet: { wallet: true }
      })
    )
    expect(mocks.listen).toHaveBeenCalledWith(4010, '0.0.0.0', expect.any(Function))
    expect(mocks.app.locals.walletRelayService).toEqual({ relay: true })
  })

  it('trims an opt-in origin allowlist before handing it to CORS and the relay', async () => {
    process.env['WALLET_PRIVATE_KEY'] = '22'.repeat(32)
    process.env['ALLOWED_ORIGINS'] = ' https://one.example, ,https://two.example '
    const mocks = installMocks()

    await import('../template/backend/server.js')

    const allowedOrigins = ['https://one.example', 'https://two.example']
    expect(mocks.cors).toHaveBeenCalledWith(expect.objectContaining({ origin: allowedOrigins }))
    expect(mocks.WalletRelayService).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigins })
    )
  })
})
