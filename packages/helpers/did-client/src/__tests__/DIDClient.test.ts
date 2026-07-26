import type { ListOutputsResult, LookupResolver, WalletInterface } from '@bsv/sdk'
import { DIDClient } from '../index.js'

const makeWallet = (): WalletInterface =>
  ({
    getNetwork: jest.fn().mockResolvedValue({ network: 'mainnet' }),
    listOutputs: jest.fn()
  }) as unknown as WalletInterface

describe('DIDClient', () => {
  it('rejects a revoke request without an identifier before calling the wallet', async () => {
    const wallet = makeWallet()
    const client = new DIDClient({ wallet })

    await expect(client.revokeDID({})).resolves.toEqual({
      status: 'error',
      code: 'ERR_MISSING_IDENTIFIER',
      description: 'Either serialNumber or outpoint must be provided'
    })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('returns a structured error when the wallet has no matching DID', async () => {
    const wallet = makeWallet()
    jest.mocked(wallet.listOutputs).mockResolvedValue({
      totalOutputs: 0,
      outputs: []
    } as ListOutputsResult)
    const client = new DIDClient({ wallet })

    await expect(client.revokeDID({ serialNumber: 'serial' })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_DID_NOT_FOUND'
    })
  })

  it('filters wallet outputs by outpoint before revocation', async () => {
    const wallet = makeWallet()
    jest.mocked(wallet.listOutputs).mockResolvedValue({
      totalOutputs: 1,
      outputs: [
        {
          outpoint: `${'1'.repeat(64)}.0`,
          satoshis: 1
        }
      ]
    } as ListOutputsResult)
    const client = new DIDClient({ wallet })

    await expect(client.revokeDID({ outpoint: `${'2'.repeat(64)}.0` })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_DID_NOT_FOUND'
    })
  })

  it('returns a structured error for malformed derivation instructions', async () => {
    const wallet = makeWallet()
    jest.mocked(wallet.listOutputs).mockResolvedValue({
      totalOutputs: 1,
      outputs: [
        {
          outpoint: `${'0'.repeat(64)}.0`,
          satoshis: 1,
          customInstructions: '{malformed',
          tags: ['did-token-subject-subject']
        }
      ],
      BEEF: [0]
    } as ListOutputsResult)
    const client = new DIDClient({ wallet })

    await expect(client.revokeDID({ serialNumber: 'serial' })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_INSTRUCTIONS'
    })
  })

  it('normalizes lookup filters and date boundaries for the resolver', async () => {
    const wallet = makeWallet()
    const query = jest.fn().mockResolvedValue({ type: 'output-list', outputs: [] })
    const resolver = { query } as unknown as LookupResolver
    const client = new DIDClient({ wallet, overlayService: 'lookup_did' })

    await expect(
      client.findDID(
        {
          serialNumber: 'serial',
          limit: 10,
          skip: 20,
          sortOrder: 'desc',
          startDate: '2026-01-02',
          endDate: '2026-02-03'
        },
        { resolver }
      )
    ).resolves.toEqual([])

    expect(query).toHaveBeenCalledWith({
      service: 'lookup_did',
      query: {
        serialNumber: 'serial',
        limit: 10,
        skip: 20,
        sortOrder: 'desc',
        startDate: '2026-01-02T00:00:00.000Z',
        endDate: '2026-02-03T23:59:59.999Z'
      }
    })
  })

  it('treats non-output resolver answers as empty results', async () => {
    const wallet = makeWallet()
    const resolver = {
      query: jest.fn().mockResolvedValue({ type: 'freeform', result: 'not an output list' })
    } as unknown as LookupResolver
    const client = new DIDClient({ wallet })

    await expect(client.findDID({}, { resolver })).resolves.toEqual([])
  })
})
