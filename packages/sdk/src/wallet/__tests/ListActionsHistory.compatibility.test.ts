import WalletClient from '../WalletClient.js'
import HTTPWalletJSON from '../substrates/HTTPWalletJSON.js'
import WalletWireProcessor from '../substrates/WalletWireProcessor.js'
import WalletWireTransceiver from '../substrates/WalletWireTransceiver.js'
import { validateWalletResult } from '../WalletResultValidation.js'
import { validateWalletArgs } from '../WalletArgumentValidation.js'
import type { ListActionsArgs, ListActionsResult, WalletInterface } from '../Wallet.interfaces.js'

const args: ListActionsArgs = {
  labels: ['history'],
  includeLabels: true,
  includeInputs: true,
  includeInputSourceLockingScripts: true,
  includeInputUnlockingScripts: true,
  includeOutputs: true,
  includeOutputLockingScripts: true
}

function history(): ListActionsResult {
  // Knex, IndexedDB and native SQLite histories use empty strings when stored
  // display metadata is absent, including ordinary wallet-generated change.
  return {
    totalActions: 1,
    actions: [
      {
        txid: 'ab'.repeat(32),
        satoshis: -1,
        status: 'completed',
        isOutgoing: true,
        description: '',
        labels: ['history'],
        version: 1,
        lockTime: 0,
        inputs: [
          {
            sourceOutpoint: `${'cd'.repeat(32)}.0`,
            sourceSatoshis: 10,
            sourceLockingScript: '51',
            unlockingScript: '51',
            inputDescription: '',
            sequenceNumber: 0xffffffff
          }
        ],
        outputs: [
          {
            satoshis: 9,
            lockingScript: '51',
            spendable: true,
            tags: [],
            outputIndex: 0,
            outputDescription: '',
            basket: ''
          }
        ]
      }
    ]
  }
}

function descriptions(result: ListActionsResult): Array<[Record<string, unknown>, string]> {
  const action = result.actions[0]
  return [
    [action as unknown as Record<string, unknown>, 'description'],
    [action.inputs![0] as unknown as Record<string, unknown>, 'inputDescription'],
    [action.outputs![0] as unknown as Record<string, unknown>, 'outputDescription']
  ]
}

describe('established BRC100 action-history metadata', () => {
  it('preserves empty descriptions and unassigned baskets through direct, JSON and binary clients', async () => {
    const result = history()
    const backend = {
      listActions: jest.fn().mockResolvedValue(result)
    } as unknown as WalletInterface
    const json = new HTTPWalletJSON(
      'app.example',
      'http://localhost:3321',
      jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => result })
    )
    const binary = new WalletWireTransceiver(new WalletWireProcessor(backend))
    for (const substrate of [backend, json, binary]) {
      await expect(new WalletClient(substrate, 'app.example').listActions(args)).resolves.toEqual(
        result
      )
    }
  })

  it.each(['', 'valid', 'é'.repeat(1000)])('preserves supported description bytes (%#)', value => {
    const result = history()
    for (const [record, field] of descriptions(result)) record[field] = value
    expect(validateWalletResult('listActions', result, args)).toEqual(result)
  })

  it.each([undefined, null, 0, {}, 'four', 'x'.repeat(2001), 'é'.repeat(1001)])(
    'rejects missing, malformed, short nonempty and oversized descriptions (%#)',
    value => {
      for (let index = 0; index < 3; index++) {
        const result = history()
        const [record, field] = descriptions(result)[index]
        record[field] = value
        expect(() => validateWalletResult('listActions', result, args)).toThrow(field)
      }
    }
  )

  it('preserves the basket byte ceiling and requires an actual string', () => {
    const result = history()
    const output = result.actions[0].outputs![0]
    for (const value of ['', 'default', 'é'.repeat(150)]) {
      output.basket = value
      expect(validateWalletResult('listActions', result, args)).toEqual(result)
    }
    for (const value of [undefined, null, 0, 'x'.repeat(301), 'é'.repeat(151)]) {
      Object.assign(output, { basket: value })
      expect(() => validateWalletResult('listActions', result, args)).toThrow('basket')
    }
  })

  it('still rejects missing requested scripts and invalid transaction values with empty metadata', () => {
    for (const change of [
      (r: ListActionsResult) => {
        r.actions[0].txid = 'invalid'
      },
      (r: ListActionsResult) => {
        r.actions[0].satoshis = Number.MAX_SAFE_INTEGER
      },
      (r: ListActionsResult) => {
        r.actions[0].outputs![0].satoshis = -1
      },
      (r: ListActionsResult) => {
        delete r.actions[0].outputs![0].lockingScript
      },
      (r: ListActionsResult) => {
        delete r.actions[0].inputs![0].sourceLockingScript
      },
      (r: ListActionsResult) => {
        delete r.actions[0].inputs![0].unlockingScript
      },
      (r: ListActionsResult) => {
        r.actions[0].labels = ['unrelated']
      }
    ]) {
      const result = history()
      change(result)
      expect(() => validateWalletResult('listActions', result, args)).toThrow(
        'Invalid listActions result'
      )
    }
  })

  it('keeps new action request descriptions and requested basket names nonempty', () => {
    expect(() => validateWalletArgs('createAction', { description: '' })).toThrow()
    expect(() =>
      validateWalletArgs('createAction', {
        description: 'Valid action',
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: '' }]
      })
    ).toThrow()
    expect(() =>
      validateWalletArgs('createAction', {
        description: 'Valid action',
        inputs: [{ outpoint: `${'ab'.repeat(32)}.0`, inputDescription: '', unlockingScript: '51' }]
      })
    ).toThrow()
    expect(() => validateWalletArgs('listOutputs', { basket: '' })).toThrow()
  })
})
