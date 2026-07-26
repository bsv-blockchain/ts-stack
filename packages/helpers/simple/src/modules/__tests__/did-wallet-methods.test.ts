import { Beef, PrivateKey, Transaction } from '@bsv/sdk'
import { WalletCore } from '../../core/WalletCore'
import { createDIDMethods } from '../did'

const TXID = 'a'.repeat(64)
const DID_STRING = `did:bsv:${TXID}`
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'

function createCore(client: Record<string, jest.Mock>, didProxyUrl?: string): WalletCore {
  return {
    defaults: {
      didBasket: 'dids',
      didProxyUrl,
      didResolverUrl: ''
    },
    getClient: jest.fn().mockReturnValue(client),
    getIdentityKey: jest.fn().mockReturnValue(SUBJECT_KEY)
  } as unknown as WalletCore
}

function chainInstructions(status: 'active' | 'deactivated'): string {
  return JSON.stringify({
    did: DID_STRING,
    identityCode: 'identity-code',
    issuanceTxid: TXID,
    subjectKey: SUBJECT_KEY,
    status
  })
}

describe('wallet-integrated DID methods', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('resolves active local chain state into a DID document', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [{ outpoint: `${TXID}.0`, customInstructions: chainInstructions('active') }]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods._resolveFromBasket(DID_STRING)).resolves.toMatchObject({
      didDocument: {
        id: DID_STRING,
        controller: DID_STRING
      },
      didDocumentMetadata: {}
    })
  })

  it('resolves deactivated local chain state and preserves its last document', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [{ outpoint: `${TXID}.0`, customInstructions: chainInstructions('deactivated') }]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods._resolveFromBasket(DID_STRING)).resolves.toMatchObject({
      didDocument: { id: DID_STRING },
      didDocumentMetadata: { deactivated: true }
    })
  })

  it('accepts a valid result from the configured proxy resolver', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        didDocument: { id: DID_STRING },
        didDocumentMetadata: {}
      })
    } as Response)
    const methods = createDIDMethods(createCore(client, 'https://resolver-proxy.example'))

    await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: { id: DID_STRING }
    })
  })

  it('ignores incomplete chain records when listing owned DIDs', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [
          {
            outpoint: `${TXID}.0`,
            customInstructions: JSON.stringify({ identityCode: 'missing-did' })
          },
          {
            outpoint: `${TXID}.1`,
            customInstructions: chainInstructions('active')
          }
        ]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods.listDIDs()).resolves.toEqual([
      expect.objectContaining({
        did: DID_STRING,
        identityCode: 'identity-code',
        status: 'active'
      })
    ])
  })

  it('fails closed when a chain spend does not return a signable transaction', async () => {
    const chainKeyHex = PrivateKey.fromRandom().toHex()
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          outputs: [
            {
              outpoint: `${TXID}.0`,
              customInstructions: JSON.stringify({
                ...JSON.parse(chainInstructions('active')),
                chainKeyHex
              })
            }
          ]
        })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] }),
      createAction: jest.fn().mockResolvedValue({})
    }
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    const methods = createDIDMethods(createCore(client))

    await expect(methods.updateDID({ did: DID_STRING })).rejects.toThrow(
      'Expected signableTransaction for chain spend'
    )
  })

  it('fails closed when signing produces no unlocking script', async () => {
    const chainKeyHex = PrivateKey.fromRandom().toHex()
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          outputs: [
            {
              outpoint: `${TXID}.0`,
              customInstructions: JSON.stringify({
                ...JSON.parse(chainInstructions('active')),
                chainKeyHex
              })
            }
          ]
        })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] }),
      createAction: jest.fn().mockResolvedValue({
        signableTransaction: { tx: [1, 2, 3], reference: 'signable-reference' }
      })
    }
    const transaction = {
      inputs: [{}],
      sign: jest.fn().mockResolvedValue(undefined)
    } as unknown as Transaction
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    jest.spyOn(Transaction, 'fromBEEF').mockReturnValue(transaction)
    const methods = createDIDMethods(createCore(client))

    await expect(methods.updateDID({ did: DID_STRING })).rejects.toThrow(
      'Failed to generate unlocking script'
    )
    expect(transaction.sign).toHaveBeenCalled()
  })
})
