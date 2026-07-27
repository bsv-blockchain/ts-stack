import { jest } from '@jest/globals'
import { LookupQuestion, OutputAdmittedByTopic } from '@bsv/overlay'
import { LockingScript, Utils } from '@bsv/sdk'
import { AnyLookupService } from '../any/AnyLookupService.js'
import { AnyStorage } from '../any/AnyStorage.js'
import { DesktopIntegrityLookupService } from '../desktopintegrity/DesktopIntegrityLookupService.js'
import { DesktopIntegrityStorage } from '../desktopintegrity/DesktopIntegrityStorage.js'
import { FractionalizeLookupService } from '../fractionalize/FractionalizeLookupService.js'
import { FractionalizeStorage } from '../fractionalize/FractionalizeStorage.js'
import { assertValidBsv20Payload } from '../shared/assertValidBsv20Payload.js'
import { errorMessage } from '../shared/errorMessage.js'
import { SlackThreadLookupService } from '../slackthreads/SlackThreadsLookupService.js'
import { SlackThreadsStorage } from '../slackthreads/SlackThreadsStorage.js'

function lookupQuestion(service: string, txid: string): LookupQuestion {
  return { service, query: { txid } }
}

function admittedPayload(
  topic: string,
  lockingScript: LockingScript,
  txid = 'strictness-regression'
): OutputAdmittedByTopic {
  return {
    mode: 'locking-script',
    topic,
    txid,
    outputIndex: 0,
    satoshis: 1,
    lockingScript
  }
}

function scriptWithData(data?: number[]): LockingScript {
  return new LockingScript([
    { op: 0 },
    data === undefined ? { op: 0x6a } : { op: data.length, data }
  ])
}

function jsonBytes(value: unknown): number[] {
  return Utils.toArray(JSON.stringify(value), 'utf8')
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('strict lookup boundaries', () => {
  it('returns no Any result when the requested transaction is absent', async () => {
    const findByTxid = jest.fn(async () => null)
    const service = new AnyLookupService({ findByTxid } as unknown as AnyStorage)

    await expect(service.lookup(lookupQuestion('ls_anytx', 'missing'))).resolves.toEqual([])
    expect(findByTxid).toHaveBeenCalledWith('missing')
  })

  it.each([
    ['missing', null, []],
    ['known', { txid: 'known', outputIndex: 0 }, [{ txid: 'known', outputIndex: 0 }]]
  ])('normalizes a Fractionalize %s transaction result', async (txid, stored, expected) => {
    const findByTxid = jest.fn(async () => stored)
    const service = new FractionalizeLookupService({
      findByTxid
    } as unknown as FractionalizeStorage)

    await expect(service.lookup(lookupQuestion('ls_fractionalize', txid))).resolves.toEqual(
      expected
    )
    expect(findByTxid).toHaveBeenCalledWith(txid)
  })
})

describe('strict locking-script payload boundaries', () => {
  it.each([
    ['missing data', undefined],
    ['wrong marker', [31, ...Array.from({ length: 32 }, () => 1)]],
    ['wrong length', [32, ...Array.from({ length: 31 }, () => 1)]]
  ])('rejects a Desktop Integrity payload with %s', async (_description, data) => {
    const storeRecord = jest.fn(async () => {})
    const service = new DesktopIntegrityLookupService({
      storeRecord
    } as unknown as DesktopIntegrityStorage)
    jest.spyOn(console, 'error').mockImplementation(() => {})

    await service.outputAdmittedByTopic(
      admittedPayload('tm_desktopintegrity', scriptWithData(data))
    )

    expect(storeRecord).not.toHaveBeenCalled()
  })

  it('stores a Desktop Integrity payload with the exact marker and hash length', async () => {
    const data = [32, ...Array.from({ length: 32 }, () => 1)]
    const storeRecord = jest.fn(async () => {})
    const service = new DesktopIntegrityLookupService({
      storeRecord
    } as unknown as DesktopIntegrityStorage)

    await service.outputAdmittedByTopic(
      admittedPayload('tm_desktopintegrity', scriptWithData(data))
    )

    expect(storeRecord).toHaveBeenCalledWith('strictness-regression', 0, Utils.toHex(data.slice(1)))
  })

  it.each([
    ['missing data', undefined],
    ['wrong length', Array.from({ length: 31 }, () => 1)]
  ])('rejects a Slack Threads payload with %s', async (_description, data) => {
    const storeRecord = jest.fn(async () => {})
    const service = new SlackThreadLookupService({
      storeRecord
    } as unknown as SlackThreadsStorage)
    jest.spyOn(console, 'error').mockImplementation(() => {})

    await service.outputAdmittedByTopic(admittedPayload('tm_slackthread', scriptWithData(data)))

    expect(storeRecord).not.toHaveBeenCalled()
  })

  it('stores a Slack Threads payload with an exact 32-byte hash', async () => {
    const data = Array.from({ length: 32 }, () => 1)
    const storeRecord = jest.fn(async () => {})
    const service = new SlackThreadLookupService({
      storeRecord
    } as unknown as SlackThreadsStorage)

    await service.outputAdmittedByTopic(admittedPayload('tm_slackthread', scriptWithData(data)))

    expect(storeRecord).toHaveBeenCalledWith('strictness-regression', 0, Utils.toHex(data))
  })
})

describe('shared BSV-20 payload validation', () => {
  it.each([
    [undefined, 'Missing JSON payload'],
    [jsonBytes(null), 'Malformed JSON payload'],
    [jsonBytes('not-an-object'), 'Malformed JSON payload'],
    [jsonBytes({ p: 'bsv-20', op: 'burn', amt: '1' }), 'Malformed JSON payload'],
    [jsonBytes({ p: 'bsv-20', op: 'deploy+mint' }), 'Malformed JSON payload'],
    [jsonBytes({ p: 'bsv-20', op: 'transfer', amt: '1' }), 'Malformed JSON payload']
  ])('rejects an invalid payload boundary', (data, expectedMessage) => {
    expect(() => assertValidBsv20Payload(data)).toThrow(expectedMessage)
  })

  it.each([
    { p: 'bsv-20', op: 'deploy+mint', amt: '1' },
    { p: 'bsv-20', op: 'transfer', id: 'token-id', amt: '1' }
  ])('accepts a supported BSV-20 payload', payload => {
    expect(() => assertValidBsv20Payload(jsonBytes(payload))).not.toThrow()
  })

  it('normalizes Error and non-Error messages with optional fallback text', () => {
    expect(errorMessage(new Error('known'), 'fallback')).toBe('known')
    expect(errorMessage('opaque')).toBe('opaque')
    expect(errorMessage('opaque', 'fallback')).toBe('fallback')
  })
})
