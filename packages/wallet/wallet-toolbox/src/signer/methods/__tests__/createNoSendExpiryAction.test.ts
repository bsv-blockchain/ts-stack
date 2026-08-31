import { Validation } from '@bsv/sdk'
import { targetForStorage } from '../createNoSendExpiryAction'
import {
  makeNoSendExpiryFundingArgs,
  selectNoSendExpiryFundingAnchor,
  validateNoSendExpiryRequest
} from '../../../storage/methods/noSendExpiry'

describe('createNoSendExpiryAction storage boundary', () => {
  test('keeps unlocking scripts and logger objects on the signer side', () => {
    const logger = {} as any
    const args = Validation.validateCreateActionArgs(
      {
        description: 'protected explicit input',
        inputBEEF: [],
        inputs: [
          {
            outpoint: `${'01'.repeat(32)}.0`,
            inputDescription: 'explicit protected input',
            unlockingScript: 'aabb'
          }
        ],
        outputs: [
          {
            lockingScript: '51',
            satoshis: 1,
            outputDescription: 'protected output'
          }
        ],
        labels: ['p nosend expiry seconds 30'],
        options: { noSend: true }
      },
      logger
    )

    const stored = targetForStorage(args)

    expect(stored.logger).toBeUndefined()
    expect(stored.inputs[0].unlockingScript).toBeUndefined()
    expect(stored.inputs[0].unlockingScriptLength).toBe(2)
    expect(args.logger).toBe(logger)
    expect(args.inputs[0].unlockingScript).toBe('aabb')

    args.options.noSendChange.push({ txid: '02'.repeat(32), vout: 1 })
    expect(stored.options.noSendChange).toEqual([])
  })

  test('attributes the funding fee without copying application or protected labels', () => {
    const funding = makeNoSendExpiryFundingArgs(5001, [
      'p nosend expiry seconds 30',
      'offer 42',
      'admin originator app.example',
      'admin month 2026-08',
      'admin originator app.example'
    ])

    expect(funding.labels).toEqual(['admin brc177 funding', 'admin originator app.example', 'admin month 2026-08'])
    expect(makeNoSendExpiryFundingArgs(5001).labels).toEqual(['admin brc177 funding'])
  })

  test('selects the fixed exact-value anchor independently of result ordering and equal-value change', () => {
    const output = (vout: number, satoshis: number, purpose = 'change') => ({
      vout,
      satoshis,
      providedBy: 'storage' as const,
      purpose,
      lockingScript: '',
      outputDescription: '',
      tags: []
    })
    const generatedCollision = output(7, 5001)
    const fixedAnchor = output(1, 5001)
    const serviceCharge = output(0, 5001, 'storage-commission')

    expect(
      selectNoSendExpiryFundingAnchor([generatedCollision, serviceCharge, fixedAnchor, output(8, 99)], 5001)
    ).toBe(fixedAnchor)
    expect(() => selectNoSendExpiryFundingAnchor([serviceCharge, output(2, 99)], 5001)).toThrow(
      'exact revocation anchor'
    )
  })

  test.each([
    [{ outputs: [] }, 'outputs'],
    [{ options: { noSend: false } }, 'options.noSend'],
    [{ options: { sendWith: ['01'.repeat(32)] } }, 'options.sendWith'],
    [{ options: { noSendChange: [{ txid: '02'.repeat(32), vout: 0 }] } }, 'options.noSendChange'],
    [{ options: { returnTXIDOnly: true } }, 'options.returnTXIDOnly']
  ])('rejects invalid protected action shape %#', (override, parameter) => {
    const valid = Validation.validateCreateActionArgs({
      description: 'protected action',
      labels: ['p nosend expiry seconds 30'],
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'recipient' }],
      options: { noSend: true }
    })
    const args = {
      ...valid,
      ...override,
      options: { ...valid.options, ...('options' in override ? override.options : {}) }
    }
    expect(() => validateNoSendExpiryRequest(args as Validation.ValidCreateActionArgs)).toThrow(parameter)
  })

  test('leaves an ordinary valid action outside BRC-177', () => {
    const args = Validation.validateCreateActionArgs({
      description: 'ordinary action',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'recipient' }]
    })
    expect(validateNoSendExpiryRequest(args)).toBeUndefined()
  })
})
