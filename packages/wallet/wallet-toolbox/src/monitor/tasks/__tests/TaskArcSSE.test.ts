import { TaskArcadeSSE } from '../TaskArcSSE'
import { ArcSSEEvent } from '../../../services/providers/ArcSSEClient'

// ── Fake EventSource ─────────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private listeners: Record<string, Array<(e: any) => void>> = {}
  closed = false

  constructor (
    public url: string,
    public opts: any
  ) {
    FakeEventSource.instances.push(this)
  }

  addEventListener (type: string, fn: (e: any) => void): void {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(fn)
  }

  emit (type: string, event: any = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }

  close (): void {
    this.closed = true
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal TableProvenTxReq API object that EntityProvenTxReq can parse */
function makeReqApi (status: string, txid = 'txid1'): any {
  const now = new Date()
  return {
    provenTxReqId: 1,
    created_at: now,
    updated_at: now,
    txid,
    rawTx: [1, 2, 3],
    status,
    history: JSON.stringify({}),
    notify: JSON.stringify({ transactionIds: [1] }),
    attempts: 0,
    notified: false
  }
}

function makeStorageWithReqs (reqApis: any[]): any {
  const sp = {
    updateProvenTxReqDynamics: jest.fn().mockResolvedValue(undefined),
    updateTransactionsStatus: jest.fn().mockResolvedValue(undefined)
  }
  return {
    isStorageProvider: jest.fn().mockReturnValue(false),
    findProvenTxReqs: jest.fn().mockResolvedValue(reqApis),
    runAsStorageProvider: jest.fn(async (fn: any) => fn(sp))
  }
}

function makeEmptyStorage (): any {
  return makeStorageWithReqs([])
}

/** Build a minimal Monitor stub */
function makeMonitor (
  overrides: {
    callbackToken?: string | null
    arcUrl?: string
    EventSourceClass?: any
    loadLastSSEEventId?: () => Promise<string | undefined>
    saveLastSSEEventId?: (id: string) => Promise<void>
    storageOverride?: any
  } = {}
): any {
  const storage = overrides.storageOverride ?? makeEmptyStorage()

  return {
    options: {
      callbackToken: overrides.callbackToken === null ? undefined : (overrides.callbackToken ?? 'test-token'),
      EventSourceClass: overrides.EventSourceClass ?? FakeEventSource,
      loadLastSSEEventId: overrides.loadLastSSEEventId,
      saveLastSSEEventId: overrides.saveLastSSEEventId
    },
    services: {
      options: { arcUrl: overrides.arcUrl ?? 'https://arc.example.com' }
    },
    chain: 'test',
    storage,
    callOnTransactionStatusChanged: jest.fn(),
    callOnProvenTransaction: jest.fn()
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskArcadeSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── asyncSetup ─────────────────────────────────────────────────────────

  describe('asyncSetup()', () => {
    test('creates and connects SSE client when fully configured', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      await task.asyncSetup()
      expect(task.sseClient).not.toBeNull()
      expect(FakeEventSource.instances.length).toBe(1)
    })

    test('skips setup when callbackToken is absent', async () => {
      const task = new TaskArcadeSSE(makeMonitor({ callbackToken: null }))
      await task.asyncSetup()
      expect(task.sseClient).toBeNull()
      expect(FakeEventSource.instances.length).toBe(0)
    })

    test('skips setup when arcUrl is absent', async () => {
      const monitor = makeMonitor({ arcUrl: '' })
      monitor.services.options.arcUrl = ''
      const task = new TaskArcadeSSE(monitor)
      await task.asyncSetup()
      expect(task.sseClient).toBeNull()
    })

    test('skips setup when EventSourceClass is absent', async () => {
      const monitor = makeMonitor()
      monitor.options.EventSourceClass = undefined
      const task = new TaskArcadeSSE(monitor)
      await task.asyncSetup()
      expect(task.sseClient).toBeNull()
    })

    test('passes loadLastSSEEventId result as lastEventId to client', async () => {
      const task = new TaskArcadeSSE(makeMonitor({ loadLastSSEEventId: async () => '77' }))
      await task.asyncSetup()
      expect(task.sseClient!.lastEventId).toBe('77')
    })

    test('continues setup when loadLastSSEEventId throws', async () => {
      const task = new TaskArcadeSSE(
        makeMonitor({
          loadLastSSEEventId: async () => {
            throw new Error('db error')
          }
        })
      )
      await expect(task.asyncSetup()).resolves.not.toThrow()
      expect(task.sseClient).not.toBeNull()
    })
  })

  // ── trigger ────────────────────────────────────────────────────────────

  describe('trigger()', () => {
    test('returns run=false when no pending events', () => {
      const task = new TaskArcadeSSE(makeMonitor())
      expect(task.trigger(Date.now()).run).toBe(false)
    })

    test('returns run=true after an SSE event is received', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      await task.asyncSetup()
      const payload: ArcSSEEvent = { txid: 'aaaa', txStatus: 'MINED', timestamp: '' }
      FakeEventSource.instances[0].emit('status', { data: JSON.stringify(payload) })
      expect(task.trigger(Date.now()).run).toBe(true)
    })
  })

  // ── runTask ────────────────────────────────────────────────────────────

  describe('runTask()', () => {
    test('returns empty string when there are no pending events', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      expect(await task.runTask()).toBe('')
    })

    test('drains pending events so trigger returns false afterward', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      await task.asyncSetup()
      const payload: ArcSSEEvent = { txid: 'bbbb', txStatus: 'SEEN_ON_NETWORK', timestamp: '' }
      FakeEventSource.instances[0].emit('status', { data: JSON.stringify(payload) })
      FakeEventSource.instances[0].emit('status', { data: JSON.stringify(payload) })
      expect(task.trigger(Date.now()).run).toBe(true)
      await task.runTask()
      expect(task.trigger(Date.now()).run).toBe(false)
    })

    test('calls callOnTransactionStatusChanged for each processed event', async () => {
      const reqApi = makeReqApi('unsent', 'cccc')
      const monitor = makeMonitor({ storageOverride: makeStorageWithReqs([reqApi]) })
      const task = new TaskArcadeSSE(monitor)
      await task.asyncSetup()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({ txid: 'cccc', txStatus: 'SEEN_ON_NETWORK', timestamp: '' })
      })
      await task.runTask()
      expect(monitor.callOnTransactionStatusChanged).toHaveBeenCalledWith('cccc', 'SEEN_ON_NETWORK')
    })

    test('logs "No matching ProvenTxReq" when storage returns empty', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      await task.asyncSetup()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({ txid: 'dddd', txStatus: 'MINED', timestamp: '' })
      })
      const log = await task.runTask()
      expect(log).toContain('No matching ProvenTxReq')
    })
  })

  // ── SSE status → ProvenTxReq transitions ──────────────────────────────

  describe('SSE status → ProvenTxReq transitions', () => {
    async function runWithStatus (txStatus: string, reqStatus: string): Promise<{ log: string, monitor: any }> {
      FakeEventSource.instances = []
      const reqApi = makeReqApi(reqStatus)
      const storage = makeStorageWithReqs([reqApi])
      const monitor = makeMonitor({ storageOverride: storage })
      const task = new TaskArcadeSSE(monitor)
      await task.asyncSetup()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({ txid: reqApi.txid, txStatus, timestamp: '' })
      })
      const log = await task.runTask()
      return { log, monitor }
    }

    test('SEEN_ON_NETWORK advances unsent req to unmined', async () => {
      const { log } = await runWithStatus('SEEN_ON_NETWORK', 'unsent')
      expect(log).toContain('=> unmined')
    })

    test('ACCEPTED_BY_NETWORK advances sending req to unmined', async () => {
      const { log } = await runWithStatus('ACCEPTED_BY_NETWORK', 'sending')
      expect(log).toContain('=> unmined')
    })

    test('SENT_TO_NETWORK advances callback req to unmined', async () => {
      const { log } = await runWithStatus('SENT_TO_NETWORK', 'callback')
      expect(log).toContain('=> unmined')
    })

    test('DOUBLE_SPEND_ATTEMPTED sets req to doubleSpend', async () => {
      const { log } = await runWithStatus('DOUBLE_SPEND_ATTEMPTED', 'unmined')
      expect(log).toContain('=> doubleSpend')
    })

    test('REJECTED sets req to invalid', async () => {
      const { log } = await runWithStatus('REJECTED', 'unmined')
      expect(log).toContain('=> invalid')
    })

    test('unknown status produces unhandled log entry', async () => {
      const { log } = await runWithStatus('SOMETHING_NEW', 'unmined')
      expect(log).toContain('unhandled status: SOMETHING_NEW')
    })

    test('does not process already-terminal reqs', async () => {
      // ProvenTxReqTerminalStatus = ['completed', 'invalid', 'doubleSpend']
      const terminalStatuses = ['completed', 'invalid', 'doubleSpend']
      for (const s of terminalStatuses) {
        const { log } = await runWithStatus('MINED', s)
        expect(log).toContain(`already terminal: ${s}`)
      }
    })
  })

  // ── fetchNow ───────────────────────────────────────────────────────────

  describe('fetchNow()', () => {
    test('returns 0 when sseClient is null', async () => {
      const task = new TaskArcadeSSE(makeMonitor({ callbackToken: null }))
      await task.asyncSetup()
      expect(await task.fetchNow()).toBe(0)
    })

    test('returns 0 when sseClient is present', async () => {
      const task = new TaskArcadeSSE(makeMonitor())
      await task.asyncSetup()
      expect(await task.fetchNow()).toBe(0)
    })
  })

  // ── saveLastSSEEventId persistence ────────────────────────────────────

  describe('saveLastSSEEventId', () => {
    test('is called when lastEventId changes on an incoming event', async () => {
      const saveLastSSEEventId = jest.fn().mockResolvedValue(undefined)
      const task = new TaskArcadeSSE(makeMonitor({ saveLastSSEEventId }))
      await task.asyncSetup()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({ txid: 'eeee', txStatus: 'MINED', timestamp: '' }),
        lastEventId: '55'
      })
      expect(saveLastSSEEventId).toHaveBeenCalledWith('55')
    })
  })
})
