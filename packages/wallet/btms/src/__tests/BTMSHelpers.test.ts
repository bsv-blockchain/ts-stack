import type { ListActionsResult } from '@bsv/sdk'
import {
  calcActionAmount,
  mapActionToTransaction,
  stripLabelPrefix,
  verifyProvenTokenAssetId
} from '../BTMSHelpers.js'
import { BTMS_LABEL_PREFIX, ISSUE_MARKER } from '../constants.js'
import { parseCustomInstructions } from '../utils.js'

const TXID = 'ab'.repeat(32)
const ASSET_ID = `${TXID}.0`

describe('BTMS helper edge cases', () => {
  it.each(['issue', 'receive', 'send', 'burn'] as const)(
    'returns zero for an empty %s action',
    type => {
      const action = {
        inputs: [],
        outputs: [],
        txid: TXID
      } as unknown as ListActionsResult['actions'][number]

      expect(calcActionAmount(action, type, ASSET_ID)).toBe(0)
    }
  )

  it('adds UTXO context when custom instructions are invalid', () => {
    expect(() =>
      parseCustomInstructions('{"senderIdentityKey":"missing derivation"}', TXID, 2)
    ).toThrow(`Invalid customInstructions for UTXO ${TXID}.2: Missing derivation info`)
  })

  it('preserves ordinary labels while removing BTMS label prefixes', () => {
    expect(stripLabelPrefix([`${BTMS_LABEL_PREFIX}type send`, 'ordinary'])).toEqual([
      'type send',
      'ordinary'
    ])
  })

  it.each([
    ['send', 'outgoing', -0],
    ['issue', 'incoming', 0]
  ] as const)('maps %s actions to the correct direction', (type, direction, amount) => {
    const action = {
      inputs: [],
      labels: [`${BTMS_LABEL_PREFIX}type ${type}`],
      outputs: [],
      txid: TXID
    } as unknown as ListActionsResult['actions'][number]

    expect(mapActionToTransaction(action, ASSET_ID)).toMatchObject({ amount, direction, type })
  })

  it('canonicalizes issuance assets and accepts explicit matching asset IDs', () => {
    verifyProvenTokenAssetId({ assetId: ISSUE_MARKER } as never, TXID, 0, ASSET_ID)
    verifyProvenTokenAssetId({ assetId: ASSET_ID } as never, TXID, 1, ASSET_ID)
    expect(() =>
      verifyProvenTokenAssetId({ assetId: 'different.0' } as never, TXID, 0, ASSET_ID)
    ).toThrow('Token asset ID does not match proof asset ID')
  })

  it('reports unknown non-Error JSON failures without losing UTXO context', () => {
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'malformed'
    })

    expect(() => parseCustomInstructions('{}', TXID, 3)).toThrow(
      `Invalid customInstructions for UTXO ${TXID}.3: Unknown error`
    )
  })
})
