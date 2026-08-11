import { classifyOutputUtxo, requireConclusiveUtxo } from '../classifyOutputUtxo'

function makeOutput(): any {
  return {
    outputId: 1,
    txid: '11'.repeat(32),
    vout: 2,
    lockingScript: [0]
  }
}

function makeServices(getUtxoStatus: jest.Mock): any {
  return {
    hashOutputScript: jest.fn().mockReturnValue('aa'.repeat(32)),
    getUtxoStatus
  }
}

describe('classifyOutputUtxo', () => {
  test.each([
    [true, 'unspent'],
    [false, 'spent']
  ])('preserves an explicit successful %s verdict as %s', async (isUtxo, verdict) => {
    const services = makeServices(
      jest.fn().mockResolvedValue({
        name: 'provider',
        status: 'success',
        details: [],
        isUtxo
      })
    )

    await expect(classifyOutputUtxo(services, makeOutput())).resolves.toEqual({
      verdict,
      provider: 'provider'
    })
    expect(services.getUtxoStatus).toHaveBeenCalledWith('aa'.repeat(32), undefined, `${'11'.repeat(32)}.2`)
  })

  test.each([
    ['error result', jest.fn().mockResolvedValue({ name: 'provider', status: 'error', details: [] })],
    ['missing verdict', jest.fn().mockResolvedValue({ name: 'provider', status: 'success', details: [] })],
    ['provider rejection', jest.fn().mockRejectedValue(new Error('rate limited'))]
  ])('classifies %s as unknown', async (_name, getUtxoStatus) => {
    const classification = await classifyOutputUtxo(makeServices(getUtxoStatus), makeOutput())

    expect(classification.verdict).toBe('unknown')
    expect(() => requireConclusiveUtxo(classification)).toThrow()
  })

  test('classifies a missing locking script as unknown without querying a provider', async () => {
    const services = makeServices(jest.fn())
    const output = makeOutput()
    output.lockingScript = undefined

    const classification = await classifyOutputUtxo(services, output)

    expect(classification).toMatchObject({
      verdict: 'unknown',
      provider: '<no-locking-script>'
    })
    expect(services.getUtxoStatus).not.toHaveBeenCalled()
  })

  test.each([
    ['missing transaction ID', { txid: undefined }],
    ['invalid transaction ID', { txid: 'not-a-txid' }],
    ['negative vout', { vout: -1 }]
  ])('classifies an output with %s as unknown without querying a provider', async (_name, update) => {
    const services = makeServices(jest.fn())
    const output = { ...makeOutput(), ...update }

    await expect(classifyOutputUtxo(services, output)).resolves.toMatchObject({
      verdict: 'unknown',
      provider: '<invalid-outpoint>'
    })
    expect(services.getUtxoStatus).not.toHaveBeenCalled()
  })

  test('classifies a malformed successful provider result as unknown', async () => {
    const services = makeServices(
      jest.fn().mockResolvedValue({ status: 'success', details: [], isUtxo: false })
    )

    await expect(classifyOutputUtxo(services, makeOutput())).resolves.toMatchObject({
      verdict: 'unknown',
      provider: '<invalid-provider-result>'
    })
  })
})
