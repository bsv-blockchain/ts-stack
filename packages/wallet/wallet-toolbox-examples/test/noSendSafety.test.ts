import { SetupWallet } from '@bsv/wallet-toolbox'
import { mintTokens, redeemTokens, sendWith } from '../src/nosend'
import type { PushDropArgs } from '../src/pushdrop'

function setupWithResults(sendWithResults: unknown): SetupWallet {
  return {
    wallet: {
      createAction: jest.fn(async () => ({ sendWithResults }))
    }
  } as unknown as SetupWallet
}

describe('no-send batch result safety', () => {
  const first = '11'.repeat(32)
  const second = '22'.repeat(32)

  test('returns one owned, canonical result for every requested transaction', async () => {
    await expect(
      sendWith(
        setupWithResults([
          { txid: second.toUpperCase(), status: 'sending' },
          { txid: first, status: 'unproven' }
        ]),
        [first, second]
      )
    ).resolves.toEqual([
      { txid: second, status: 'sending' },
      { txid: first, status: 'unproven' }
    ])
  })

  test('rejects ambiguous result objects without invoking accessors', async () => {
    let invoked = 0
    const result = { status: 'sending' }
    Object.defineProperty(result, 'txid', {
      enumerable: true,
      get() {
        invoked += 1
        return first
      }
    })

    await expect(sendWith(setupWithResults([result]), [first])).rejects.toThrow('invalid')
    expect(invoked).toBe(0)
  })

  test.each([
    [[], 'at least one'],
    [['not-a-txid'], 'invalid transaction ID'],
    [[first, first.toUpperCase()], 'must be unique']
  ])('rejects hostile submitted transaction IDs %#', async (txids, expected) => {
    const setup = setupWithResults([])
    await expect(sendWith(setup, txids)).rejects.toThrow(expected)
    expect(setup.wallet.createAction).not.toHaveBeenCalled()
  })

  test.each([
    [undefined, 'one sendWith result'],
    [[], 'one sendWith result'],
    [[{ txid: first, status: 'sent' }], 'invalid sendWith result'],
    [[{ txid: 'not-a-txid', status: 'sending' }], 'invalid sendWith result'],
    [[{ txid: second, status: 'sending' }], 'unexpected or duplicate'],
    [
      [
        { txid: first, status: 'sending' },
        { txid: first, status: 'sending' }
      ],
      'unexpected or duplicate'
    ]
  ])('rejects unauthoritative wallet result sets %#', async (results, expected) => {
    const submitted = results?.length === 2 ? [first, second] : [first]
    await expect(sendWith(setupWithResults(results), submitted)).rejects.toThrow(expected)
  })

  test('rejects sparse, extended, and non-plain wallet result structures', async () => {
    const sparse: unknown[] = []
    sparse.length = 1
    await expect(sendWith(setupWithResults(sparse), [first])).rejects.toThrow('invalid')

    const extended = [{ txid: first, status: 'sending' }] as Array<{
      txid: string
      status: string
    }> & { extra?: boolean }
    extended.extra = true
    await expect(sendWith(setupWithResults(extended), [first])).rejects.toThrow('result array')

    await expect(sendWith(setupWithResults([new (class Result {})()]), [first])).rejects.toThrow(
      'invalid'
    )
    await expect(
      sendWith(setupWithResults([{ txid: first, status: 'sending', extra: true }]), [first])
    ).rejects.toThrow('invalid')
  })
})

describe('no-send token input validation', () => {
  const args: PushDropArgs = {
    protocolID: [2, 'secure-example'],
    keyID: 'key-1',
    includeSignature: false,
    lockPosition: 'before',
    counterparty: 'self',
    fields: [[1, 2, 3]]
  }

  test.each([
    [-1, 3, 'safe integer'],
    [1.5, 3, 'safe integer'],
    [1_001, 3, 'safe integer'],
    [0, 0, 'field size'],
    [0, 1.5, 'field size'],
    [0, 1_048_577, 'field size'],
    [0, 2, 'does not match']
  ])('bounds mint work before wallet access %#', async (count, size, expected) => {
    const setup = setupWithResults([])
    await expect(mintTokens(setup, args, count, size)).rejects.toThrow(expected)
    expect(setup.wallet.createAction).not.toHaveBeenCalled()
  })

  test('returns an owned empty mint result and snapshots forwarded change', async () => {
    const noSendChange = [`${'33'.repeat(32)}.0`]
    const result = await mintTokens(setupWithResults([]), args, 0, 3, noSendChange)
    noSendChange[0] = `${'44'.repeat(32)}.0`
    expect(result).toEqual({ tokens: [], noSendChange: [`${'33'.repeat(32)}.0`] })
  })

  test.each([
    [null, 'bounded array'],
    [Object.assign([], { length: 1_001 }), 'bounded array'],
    [Object.assign([], { length: 1 }), 'dense own-data array']
  ])('rejects hostile redemption arrays %#', async (tokens, expected) => {
    await expect(redeemTokens(setupWithResults([]), tokens as never)).rejects.toThrow(expected)
  })

  test('rejects extended redemption arrays before consuming tokens', async () => {
    const tokens = [] as unknown[] & { extra?: boolean }
    tokens.extra = true
    await expect(redeemTokens(setupWithResults([]), tokens as never)).rejects.toThrow(
      'extra properties'
    )
  })
})
