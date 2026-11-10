import { Beef, HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import { TaskSendWaiting } from '../../src/monitor/tasks/TaskSendWaiting'
import { ARC } from '../../src/services/providers/ARC'
import { WERR_INTERNAL } from '../../src/sdk/WERR_errors'
import { PostBeefResult } from '../../src/sdk/WalletServices.interfaces'
import { EntityProvenTxReq } from '../../src/storage/schema/entities/EntityProvenTxReq'
import { verifyOne, verifyTruthy, wait } from '../../src/utility/utilityHelpers'
import { _tu, TestWallet } from '../utils/TestUtilsWalletStorage'

/**
 * End to end through storage: the wallet broadcasts its waiting transactions through a real
 * {@link ARC} provider whose HTTP transport answers the way an API-key protected ARC does
 * (arc.taal.com answers every keyless POST /v1/tx with 401). A missing or refused key (401/403)
 * must leave the requests queued for retry — never mark the transactions invalid and release
 * their inputs — while a genuine validation rejection still fails them. Mirrors
 * TaskSendWaitingArcadeApiKey.test.ts.
 */

const API_KEY = 'mainnet_00000000000000000000000000000000'

// The unsent requests in the legacy wallet fixture (see Monitor.test.ts).
const EXPECTED_TXIDS = [
  'd9ec73b2e0f06e0f482d2d1db9ceccf2f212f0b24afbe10846ac907567be571f',
  'b7634f08d8c7f3c6244050bebf73a79f40e672aba7d5232663609a58b123b816',
  '3d2ea64ee584a1f6eb161dbedf3a8d299e3e4497ac7a203d23c044c998c6aa08',
  'a3a8fe7f541c1383ff7b975af49b27284ae720af5f2705d8409baaf519190d26',
  '6d68cc6fa7363e59aaccbaa65f0ca613a6ae8af718453ab5d3a2b022c59b5cc6'
]

interface Captured {
  url: string
  authorization: string | undefined
}

function arcAnswering(
  response: Pick<HttpClientResponse<unknown>, 'ok' | 'status' | 'statusText' | 'data'>,
  captured: Captured[],
  apiKey: string | undefined
): ARC {
  const httpClient: HttpClient = {
    async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      captured.push({ url, authorization: (options.headers as Record<string, string>)?.Authorization })
      return response as HttpClientResponse<D>
    }
  }
  return new ARC('https://arc.example', { httpClient, apiKey })
}

describe('TaskSendWaiting through an API-key protected ARC', () => {
  jest.setTimeout(99999999)

  const ctxs: TestWallet<{}>[] = []
  afterEach(async () => {
    for (const ctx of ctxs.splice(0)) await ctx.storage.destroy()
  })

  async function sendWaitingThrough(arc: ARC, database: string): Promise<TestWallet<{}>> {
    const ctx = await _tu.createLegacyWalletSQLiteCopy(database)
    ctxs.push(ctx)
    ctx.services.postBeef = jest.fn(async (beef: Beef, txids: string[]): Promise<PostBeefResult[]> =>
      // once a parent is rejected, its dependents are posted with nothing left to send
      txids.length === 0 ? [] : [await arc.postBeef(beef, txids)]
    )
    const { activeStorage: storage, monitor } = ctx
    if (monitor == null) throw new WERR_INTERNAL('test requires setup with monitor')

    for (const txid of EXPECTED_TXIDS) {
      expect(verifyOne(await storage.findProvenTxReqs({ partial: { txid } })).status).toBe('unsent')
    }

    monitor._tasks.push(new TaskSendWaiting(monitor, 1, 1))
    await wait(5)
    await monitor.runTask('SendWaiting')
    return ctx
  }

  async function transactionStatuses(ctx: TestWallet<{}>, txid: string): Promise<string[]> {
    const req = verifyOne(await ctx.activeStorage.findProvenTxReqs({ partial: { txid } }))
    const statuses: string[] = []
    for (const transactionId of new EntityProvenTxReq(req).notify.transactionIds ?? []) {
      statuses.push(verifyTruthy(await ctx.activeStorage.findTransactionById(transactionId)).status)
    }
    return statuses
  }

  test.each([
    [401, 'Authentication error: authorization key not found', 'Unauthorized', API_KEY],
    [401, 'Authentication error: no authorization token provided', 'Unauthorized', undefined],
    [403, 'Forbidden', 'Forbidden', API_KEY]
  ] as const)('HTTP %i "%s" keeps every request queued for retry', async (status, message, statusText, apiKey) => {
    const captured: Captured[] = []
    const arc = arcAnswering({ ok: false, status, statusText, data: { message } }, captured, apiKey)

    const ctx = await sendWaitingThrough(arc, `arcApiKey${status}${apiKey == null ? 'Keyless' : ''}`)

    // every waiting tx really reached ARC, with the key when one is configured, and was refused there
    expect(captured.length).toBeGreaterThanOrEqual(EXPECTED_TXIDS.length)
    for (const c of captured) {
      expect(c.url).toBe('https://arc.example/v1/tx')
      expect(c.authorization).toBe(apiKey == null ? undefined : `Bearer ${apiKey}`)
    }

    for (const txid of EXPECTED_TXIDS) {
      const req = verifyOne(await ctx.activeStorage.findProvenTxReqs({ partial: { txid } }))
      expect(req.status).toBe('sending')
      expect(req.attempts).toBeGreaterThan(0)
      expect(await transactionStatuses(ctx, txid)).not.toContain('failed')
    }
  })

  test('control: an ARC validation rejection (HTTP 464) still marks the requests invalid', async () => {
    const captured: Captured[] = []
    const arc = arcAnswering(
      { ok: false, status: 464, statusText: 'Invalid Inputs', data: { detail: 'script evaluation failed' } },
      captured,
      API_KEY
    )

    const ctx = await sendWaitingThrough(arc, 'arcApiKey464')

    expect(captured.length).toBeGreaterThan(0)
    for (const txid of EXPECTED_TXIDS) {
      const req = verifyOne(await ctx.activeStorage.findProvenTxReqs({ partial: { txid } }))
      expect(req.status).toBe('invalid')
    }
  })
})
