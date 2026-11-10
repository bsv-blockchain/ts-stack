import { Transaction, UnlockingScript } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { BlockHeader, WalletServices } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { MockServices } from '../../mockchain/MockServices'
import { Services, toBinaryBaseBlockHeader } from '../Services'
import { getMedianTimePast } from '../getMedianTimePast'

/**
 * The network accepts a transaction into the next block when nLockTime is below
 * that block's height (tip + 1), or, for a time lock, below the median time past
 * of the tip and its ten predecessors (BIP113). Equality is not final.
 */

const TIP = 800_000
// Eleven header times, tip last. Deliberately unordered so the median differs
// from the tip's own time and from the time of any fixed offset below the tip.
const TIMES = [
  1_700_000_300, 1_700_000_100, 1_700_000_900, 1_700_000_500, 1_700_000_200, 1_700_000_800, 1_700_000_400,
  1_700_001_000, 1_700_000_600, 1_700_000_700, 1_700_002_000
]
const MTP = 1_700_000_600
// Headers below the eleven most recent must not influence the median.
const OLDER_TIME = 1_900_000_000
const GENESIS_PREVIOUS_HASH = '00'.repeat(32)

function makeHeaders(firstHeight: number, times: number[]): BlockHeader[] {
  const headers: BlockHeader[] = []
  let previousHash = GENESIS_PREVIOUS_HASH
  times.forEach((time, i) => {
    const height = firstHeight + i
    const base = { version: 1, previousHash, merkleRoot: '11'.repeat(32), time, bits: 0x1d00ffff, nonce: height }
    const hash = asString(doubleSha256BE(toBinaryBaseBlockHeader(base)))
    headers.push({ ...base, height, hash })
    previousHash = hash
  })
  return headers
}

// Thirteen headers ending at TIP; the oldest one has an all-zero previousHash, but
// the walk must stop after eleven headers before reaching it.
function makeChain(): BlockHeader[] {
  return makeHeaders(TIP - 12, [OLDER_TIME, OLDER_TIME, ...TIMES])
}

function lockedTx(lockTime: number, sequences: number[] = [0xfffffffe, 0xffffffff]): Transaction {
  return new Transaction(
    1,
    sequences.map((sequence, i) => ({ sourceTXID: 'aa'.repeat(32), sourceOutputIndex: i, sequence })),
    [],
    lockTime
  )
}

type HeaderSource = Pick<WalletServices, 'getHeight' | 'getHeaderForHeight' | 'hashToHeader'>

function headerSource(headers: BlockHeader[]): HeaderSource {
  const tip = headers[headers.length - 1]
  return {
    getHeight: async () => tip.height,
    getHeaderForHeight: async (height: number) => {
      const header = headers.find(h => h.height === height)
      if (header == null) throw new Error(`no header at ${height}`)
      return toBinaryBaseBlockHeader(header)
    },
    hashToHeader: async (hash: string) => {
      const header = headers.find(h => h.hash === hash)
      if (header == null) throw new Error(`no header ${hash}`)
      return header
    }
  }
}

function useChain(services: HeaderSource, headers = makeChain()): void {
  const source = headerSource(headers)
  jest.spyOn(services, 'getHeight').mockImplementation(source.getHeight)
  jest.spyOn(services, 'getHeaderForHeight').mockImplementation(source.getHeaderForHeight)
  jest.spyOn(services, 'hashToHeader').mockImplementation(source.hashToHeader)
}

function setWallClock(seconds: number): void {
  jest.spyOn(Date, 'now').mockReturnValue(seconds * 1000)
}

afterEach(() => {
  jest.restoreAllMocks()
})

test('fixture: MTP is the 6th of 11 sorted times and differs from the tip time', () => {
  const sorted = [...TIMES].sort((a, b) => a - b)
  expect(sorted[5]).toBe(MTP)
  expect(TIMES[10]).not.toBe(MTP)
})

describe('getMedianTimePast', () => {
  test('reads the tip by height and its ten predecessors by previousHash, once each', async () => {
    const source = headerSource(makeChain())
    const getHeaderForHeight = jest.spyOn(source, 'getHeaderForHeight')
    const hashToHeader = jest.spyOn(source, 'hashToHeader')
    expect(await getMedianTimePast(source)).toBe(MTP)
    expect(getHeaderForHeight).toHaveBeenCalledTimes(1)
    expect(getHeaderForHeight).toHaveBeenCalledWith(TIP)
    expect(hashToHeader).toHaveBeenCalledTimes(10)
  })

  test('on a chain shorter than eleven headers it stops at genesis', async () => {
    // Heights 0..4; the median of [10, 50, 30, 20, 40] is 30.
    const source = headerSource(makeHeaders(0, [10, 50, 30, 20, 40]))
    const hashToHeader = jest.spyOn(source, 'hashToHeader')
    expect(await getMedianTimePast(source)).toBe(30)
    expect(hashToHeader).toHaveBeenCalledTimes(4)
    expect(hashToHeader).not.toHaveBeenCalledWith(GENESIS_PREVIOUS_HASH)
  })

  test('on an even number of headers it takes the upper middle of the numerically sorted times', async () => {
    // Sorted numerically [9, 30, 100, 2000], the upper middle is 100, as on the node.
    // The lower middle, or a lexicographic sort ([100, 2000, 30, 9]), would give 30.
    expect(await getMedianTimePast(headerSource(makeHeaders(0, [100, 9, 30, 2000])))).toBe(100)
  })

  test('a header that reports height 0 below a non-zero previousHash does not shorten the window', async () => {
    // Height is not part of the hashed header, so it cannot mark genesis.
    const headers = makeChain().map(h => (h.height === TIP - 5 ? { ...h, height: 0 } : h))
    expect(await getMedianTimePast(headerSource(headers))).toBe(MTP)
  })

  test('a header read failure propagates', async () => {
    const error = new Error('headers unavailable')
    const source = headerSource(makeChain())
    jest.spyOn(source, 'hashToHeader').mockRejectedValue(error)
    await expect(getMedianTimePast(source)).rejects.toBe(error)
  })
})

const factories: Array<[string, () => WalletServices]> = [
  ['Services', () => new Services('main')],
  ['MockServices', () => new MockServices({} as unknown as Knex)]
]

describe.each(factories)('%s.nLockTimeIsFinal', (_name, makeServices) => {
  let services: WalletServices

  beforeEach(() => {
    services = makeServices()
    useChain(services)
  })

  test('a height lock equal to the tip is final: it can be mined in the next block', async () => {
    expect(await services.nLockTimeIsFinal(TIP)).toBe(true)
    expect(await services.nLockTimeIsFinal(lockedTx(TIP))).toBe(true)
  })

  test('inputs whose sequence is omitted count as final, as they serialize as 0xffffffff', async () => {
    const tx = new Transaction(
      1,
      [{ sourceTXID: 'aa'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() }],
      [],
      TIP + 100
    )
    expect(await services.nLockTimeIsFinal(tx)).toBe(true)
    expect(await services.nLockTimeIsFinal(tx.toHex())).toBe(true)
    expect(await services.nLockTimeIsFinal(tx.toBinary())).toBe(true)
  })

  test('500,000,000 is the first time-based lock time', async () => {
    // Height path: far above the tip, so not final.
    expect(await services.nLockTimeIsFinal(499_999_999)).toBe(false)
    // Time path: far below median time past, so final.
    expect(await services.nLockTimeIsFinal(500_000_000)).toBe(true)
  })

  test('a height lock equal to the next block height is not final', async () => {
    expect(await services.nLockTimeIsFinal(TIP + 1)).toBe(false)
    expect(await services.nLockTimeIsFinal(lockedTx(TIP + 1))).toBe(false)
    expect(await services.nLockTimeIsFinal(TIP - 1)).toBe(true)
  })

  test.each([
    ['ahead of', 'MTP - 1', true, 1_000_000, -1],
    ['ahead of', 'MTP', false, 1_000_000, 0],
    ['ahead of', 'MTP + 1', false, 1_000_000, 1],
    ['behind', 'MTP - 1', true, -1_000_000, -1],
    ['behind', 'MTP', false, -1_000_000, 0],
    ['behind', 'MTP + 1', false, -1_000_000, 1]
  ])(
    'with the wall clock far %s median time past, a time lock of %s is final: %s',
    async (_direction, _label, final, clockOffset, lockOffset) => {
      setWallClock(MTP + clockOffset)
      expect(await services.nLockTimeIsFinal(MTP + lockOffset)).toBe(final)
      expect(await services.nLockTimeIsFinal(lockedTx(MTP + lockOffset))).toBe(final)
    }
  )

  test('all-final input sequences make any lock time final without reading the chain', async () => {
    const getHeight = jest.spyOn(services, 'getHeight').mockRejectedValue(new Error('chain unavailable'))
    expect(await services.nLockTimeIsFinal(lockedTx(TIP + 100, [0xffffffff, 0xffffffff]))).toBe(true)
    expect(await services.nLockTimeIsFinal(lockedTx(MTP + 100_000, [0xffffffff]))).toBe(true)
    expect(getHeight).not.toHaveBeenCalled()
  })

  test('a zero lock time is final without reading the chain', async () => {
    const getHeight = jest.spyOn(services, 'getHeight').mockRejectedValue(new Error('chain unavailable'))
    expect(await services.nLockTimeIsFinal(0)).toBe(true)
    expect(await services.nLockTimeIsFinal(lockedTx(0))).toBe(true)
    expect(getHeight).not.toHaveBeenCalled()
  })

  test('when median time past cannot be read, the header service error propagates whatever the wall clock says', async () => {
    setWallClock(MTP + 1_000_000)
    const error = new Error('headers unavailable')
    jest.spyOn(services, 'hashToHeader').mockRejectedValue(error)
    await expect(services.nLockTimeIsFinal(MTP - 1)).rejects.toBe(error)
    await expect(services.nLockTimeIsFinal(lockedTx(MTP - 1))).rejects.toBe(error)
  })
})

describe('MockServices.nLockTimeIsFinal on a mined mock chain', () => {
  const BASE = 1_700_000_000
  let clock = BASE
  let knex: Knex
  let services: MockServices

  async function mineAt(seconds: number): Promise<void> {
    clock = seconds
    await services.mineBlock()
  }

  async function storedMedianTime(): Promise<number> {
    const tip = await services.getHeight()
    const times: number[] = []
    for (let height = Math.max(0, tip - 10); height <= tip; height++) {
      times.push((await services.storage.getBlockHeaderByHeight(height))!.time)
    }
    times.sort((a, b) => a - b)
    return times[Math.floor(times.length / 2)]
  }

  beforeEach(async () => {
    // MockMiner stamps each block with the wall clock, so control it to give the
    // stored headers distinct, unordered times.
    jest.spyOn(Date, 'now').mockImplementation(() => clock * 1000)
    knex = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    services = new MockServices(knex)
    clock = BASE + 10
    await services.initialize()
    for (const offset of [50, 30, 20, 40]) await mineAt(BASE + offset)
  })

  afterEach(async () => {
    await knex.destroy()
  })

  test('a short chain walks to genesis and the stored block times decide finality', async () => {
    expect(await services.getHeight()).toBe(4)
    expect(await getMedianTimePast(services)).toBe(BASE + 30)
    clock = BASE + 1_000_000
    expect(await services.nLockTimeIsFinal(lockedTx(4))).toBe(true)
    expect(await services.nLockTimeIsFinal(lockedTx(5))).toBe(false)
    expect(await services.nLockTimeIsFinal(lockedTx(BASE + 29))).toBe(true)
    expect(await services.nLockTimeIsFinal(lockedTx(BASE + 30))).toBe(false)
  })

  test('after a reorg the walk follows the new chain', async () => {
    for (let i = 0; i < 12; i++) await mineAt(BASE + 100 + ((i * 7) % 12))
    clock = BASE + 500
    const { newTip } = await services.reorg((await services.getHeight()) - 3, 5)
    expect(await services.getHeight()).toBe(newTip.height)
    expect(await getMedianTimePast(services)).toBe(await storedMedianTime())
  })
})
