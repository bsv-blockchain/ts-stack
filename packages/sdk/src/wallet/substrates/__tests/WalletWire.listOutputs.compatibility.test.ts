import { WalletInterface } from '../../Wallet.interfaces.js'
import WalletWireProcessor from '../WalletWireProcessor.js'
import WalletWireTransceiver from '../WalletWireTransceiver.js'
import fixtures from './fixtures/listOutputs-sdk-3.2.1.json'

const bytes = (hex: string): number[] => Array.from(Buffer.from(hex, 'hex'))

describe('published SDK 3.2.1 listOutputs binary compatibility', () => {
  it.each(fixtures.cases)('new caller reads old wallet: $name', async fixture => {
    const transport = jest.fn(async (request: number[]) => {
      expect(request).toEqual(bytes(fixture.requestHex))
      return bytes(fixture.responseHex)
    })
    const caller = new WalletWireTransceiver({ transmitToWallet: transport })

    await expect(caller.listOutputs(fixture.args, fixture.originator)).resolves.toEqual({
      ...fixture.result,
      ...('BEEF' in fixture.result ? { BEEF: Uint8Array.from(fixture.result.BEEF) } : {})
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each(fixtures.cases)('old caller reads new wallet: $name', async fixture => {
    const listOutputs = jest.fn(async () => fixture.result)
    const processor = new WalletWireProcessor({ listOutputs } as unknown as WalletInterface)

    await expect(processor.transmitToWallet(bytes(fixture.requestHex))).resolves.toEqual(
      bytes(fixture.responseHex)
    )
    expect(listOutputs).toHaveBeenCalledTimes(1)
    expect(listOutputs).toHaveBeenCalledWith(fixture.args, fixture.originator)
  })
})

describe('explicit listOutputs spendability extension', () => {
  const fixture = fixtures.cases[0]
  const result = {
    ...fixture.result,
    outputs: fixture.result.outputs.map((output, index) => ({ ...output, spendable: index !== 0 }))
  }

  it('preserves false only after an explicit request, without changing legacy requests', async () => {
    const processor = new WalletWireProcessor({
      listOutputs: async () => result
    } as unknown as WalletInterface)
    const transport = jest.fn(async (request: number[]) => {
      expect(request).toEqual([...bytes(fixture.requestHex), 1])
      return await processor.transmitToWallet(request)
    })
    const caller = new WalletWireTransceiver(
      { transmitToWallet: transport },
      { listOutputsEncoding: 'spendable' }
    )

    await expect(caller.listOutputs(fixture.args, fixture.originator)).resolves.toEqual(result)
    expect(transport).toHaveBeenCalledTimes(1)
    await expect(
      new WalletWireTransceiver(processor).listOutputs(fixture.args, fixture.originator)
    ).rejects.toThrow('Non-spendable listOutputs records require')
  })

  it.each([[0], [2], [255], [1, 1]])(
    'rejects an unknown or trailing extension before calling the wallet: %j',
    async (...extension: number[]) => {
      const listOutputs = jest.fn(async () => result)
      const processor = new WalletWireProcessor({ listOutputs } as unknown as WalletInterface)
      const response = await processor.transmitToWallet([
        ...bytes(fixture.requestHex),
        ...extension
      ])

      expect(response[0]).not.toBe(0)
      expect(listOutputs).not.toHaveBeenCalled()
    }
  )

  it('rejects an old response if a transport silently ignores the extension', async () => {
    const transport = jest.fn(async () => bytes(fixture.responseHex))
    const caller = new WalletWireTransceiver(
      { transmitToWallet: transport },
      { listOutputsEncoding: 'spendable' }
    )

    await expect(caller.listOutputs(fixture.args)).rejects.toThrow('encoding acknowledgement')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('preserves exact module balance text on an explicitly extended connection', async () => {
    const balance = { totalOutputs: '18446744073709551616', outputs: [] }
    const caller = new WalletWireTransceiver(
      new WalletWireProcessor({ listOutputs: async () => balance } as unknown as WalletInterface),
      { listOutputsEncoding: 'spendable' }
    )

    await expect(caller.listOutputs({ basket: 'p color balance aa' })).resolves.toEqual(balance)
  })

  it('does not retry an unsupported extension as another format', async () => {
    const transport = jest.fn(async () => {
      throw new Error('Unsupported extension')
    })
    const caller = new WalletWireTransceiver(
      { transmitToWallet: transport },
      { listOutputsEncoding: 'spendable' }
    )

    await expect(caller.listOutputs(fixture.args)).rejects.toThrow('Unsupported extension')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid encoding selection', () => {
    expect(
      () =>
        new WalletWireTransceiver(
          { transmitToWallet: async () => [] },
          { listOutputsEncoding: 'unknown' as 'legacy' }
        )
    ).toThrow('Invalid listOutputs encoding')
  })
})
