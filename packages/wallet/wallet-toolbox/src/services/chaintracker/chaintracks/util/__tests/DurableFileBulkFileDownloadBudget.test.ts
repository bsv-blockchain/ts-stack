import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { DurableFileBulkFileDownloadBudget } from '../DurableFileBulkFileDownloadBudget'

describe('DurableFileBulkFileDownloadBudget', () => {
  let root: string
  let stateFile: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'bulk-budget-'))
    stateFile = path.join(root, 'state.json')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test('persists reservations across process-equivalent reconstruction', async () => {
    const first = new DurableFileBulkFileDownloadBudget({ maxBytes: 100, stateFile, now: () => 1000 })
    await first.consume(60)

    const restarted = new DurableFileBulkFileDownloadBudget({ maxBytes: 100, stateFile, now: () => 1001 })
    await restarted.initialize()
    expect(restarted.snapshot()).toMatchObject({ consumedBytes: 60, remainingBytes: 40 })
    await expect(restarted.consume(41)).rejects.toThrow('40 bytes remaining')
    await expect(restarted.consume(40)).resolves.toBeUndefined()
    expect(restarted.snapshot().consumedBytes).toBe(100)
  })

  test('serializes concurrent reservations before resolving callers', async () => {
    const budget = new DurableFileBulkFileDownloadBudget({ maxBytes: 100, stateFile })
    const results = await Promise.allSettled([budget.consume(60), budget.consume(60)])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { consumedBytes: number }
    expect(state.consumedBytes).toBe(60)
  })

  test('fails closed when durable state is corrupt', async () => {
    await fs.writeFile(stateFile, '{not-json')
    const budget = new DurableFileBulkFileDownloadBudget({ maxBytes: 100, stateFile })

    await expect(budget.initialize()).rejects.toThrow('Unable to read durable bulk-header download budget')
    await expect(budget.consume(1)).rejects.toThrow('Unable to read durable bulk-header download budget')
  })

  test('starts a new durable window only after the configured interval', async () => {
    let now = 1000
    const budget = new DurableFileBulkFileDownloadBudget({
      maxBytes: 10,
      stateFile,
      windowMsecs: 100,
      now: () => now
    })
    await budget.consume(10)
    now = 1099
    await expect(budget.consume(1)).rejects.toThrow('0 bytes remaining')
    now = 1100
    await expect(budget.consume(10)).resolves.toBeUndefined()
    expect(budget.snapshot()).toMatchObject({ consumedBytes: 10, windowStartedAt: 1100 })
  })

  test('applies configuration changes without resetting the active allowance early', async () => {
    let now = 1000
    const first = new DurableFileBulkFileDownloadBudget({
      maxBytes: 100,
      stateFile,
      windowMsecs: 100,
      now: () => now
    })
    await first.consume(80)

    const reconfigured = new DurableFileBulkFileDownloadBudget({
      maxBytes: 50,
      stateFile,
      windowMsecs: 50,
      now: () => now
    })
    await reconfigured.initialize()
    expect(reconfigured.snapshot()).toMatchObject({
      maxBytes: 50,
      consumedBytes: 50,
      remainingBytes: 0,
      windowMsecs: 100
    })
    await expect(reconfigured.consume(1)).rejects.toThrow('0 bytes remaining')

    now = 1100
    await expect(reconfigured.consume(50)).resolves.toBeUndefined()
    expect(reconfigured.snapshot()).toMatchObject({ consumedBytes: 50, windowMsecs: 50 })
  })
})
