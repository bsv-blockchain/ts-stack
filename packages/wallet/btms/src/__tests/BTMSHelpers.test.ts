import type { ListActionsResult } from '@bsv/sdk'
import { calcActionAmount } from '../BTMSHelpers.js'
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
})
