import { MerklePath } from '@bsv/sdk'
import { ProvenTxReqTerminalStatus } from '../../sdk/types'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { EntityProvenTx } from '../../storage/schema/entities/EntityProvenTx'
import { ArcSSEClient, ArcSSEEvent } from '../../services/providers/ArcSSEClient'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { Services } from '../../services/Services'

/**
 * Monitor task that receives transaction status updates from Arcade via SSE
 * and processes them — including fetching merkle proofs directly from Arcade
 * when transactions are MINED.
 */
export class TaskArcadeSSE extends WalletMonitorTask {
  static taskName = 'ArcadeSSE'

  sseClient: ArcSSEClient | null = null
  private readonly pendingEvents: ArcSSEEvent[] = []

  constructor (monitor: Monitor) {
    super(monitor, TaskArcadeSSE.taskName)
  }

  override async asyncSetup (): Promise<void> {
    const callbackToken = this.monitor.options.callbackToken
    if (!callbackToken) {
      console.log('[TaskArcadeSSE] no callbackToken configured — SSE disabled')
      return
    }

    const arcUrl = (this.monitor.services as Services).options?.arcUrl
    if (!arcUrl) {
      console.log('[TaskArcadeSSE] no arcUrl configured — SSE disabled')
      return
    }

    const EventSourceClass = this.monitor.options.EventSourceClass
    if (!EventSourceClass) {
      console.log('[TaskArcadeSSE] no EventSourceClass provided — SSE disabled')
      return
    }

    let lastEventId: string | undefined
    try {
      lastEventId = await this.monitor.options.loadLastSSEEventId?.()
      console.log(`[TaskArcadeSSE] loaded persisted lastEventId: ${lastEventId ?? '(none)'}`)
    } catch (e) {
      console.log(`[TaskArcadeSSE] failed to load lastEventId: ${e}`)
    }

    const arcApiKey = (this.monitor.services as Services).options?.arcConfig?.apiKey

    console.log(`[TaskArcadeSSE] setting up — arcUrl=${arcUrl} token=${callbackToken.substring(0, 8)}...`)

    this.sseClient = new ArcSSEClient({
      baseUrl: arcUrl,
      callbackToken,
      arcApiKey,
      lastEventId,
      EventSourceClass,
      onEvent: event => {
        this.pendingEvents.push(event)
      },
      onError: err => {
        console.log(`[TaskArcadeSSE] error: ${err.message}`)
      },
      onLastEventIdChanged: (id: string) => {
        this.monitor.options.saveLastSSEEventId?.(id).catch(e => {
          console.log(`[TaskArcadeSSE] failed to persist lastEventId: ${e}`)
        })
      }
    })

    this.sseClient.connect()
  }

  trigger (_nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: this.pendingEvents.length > 0 }
  }

  async runTask (): Promise<string> {
    const events = this.pendingEvents.splice(0)
    if (events.length === 0) return ''

    let log = ''
    for (const event of events) {
      log += await this.processStatusEvent(event)
    }
    return log
  }

  async fetchNow (): Promise<number> {
    if (this.sseClient == null) return 0
    return await this.sseClient.fetchEvents()
  }

  private async processStatusEvent (event: ArcSSEEvent): Promise<string> {
    let log = `SSE: txid=${event.txid} status=${event.txStatus}\n`

    const reqs = await this.storage.findProvenTxReqs({
      partial: { txid: event.txid }
    })

    if (reqs.length === 0) {
      log += '  No matching ProvenTxReq\n'
      return log
    }

    for (const reqApi of reqs) {
      const req = new EntityProvenTxReq(reqApi)

      if (ProvenTxReqTerminalStatus.includes(req.status)) {
        log += `  req ${req.id} already terminal: ${req.status}\n`
        continue
      }

      const note = {
        when: new Date().toISOString(),
        what: 'arcSSE',
        arcStatus: event.txStatus
      }

      switch (event.txStatus) {
        case 'SENT_TO_NETWORK':
        case 'ACCEPTED_BY_NETWORK':
        case 'SEEN_ON_NETWORK': {
          if (['unsent', 'sending', 'callback'].includes(req.status)) {
            req.status = 'unmined'
            req.addHistoryNote(note)
            await req.updateStorageDynamicProperties(this.storage)
            const ids = req.notify.transactionIds
            if (ids != null) {
              await this.storage.runAsStorageProvider(async sp => {
                await sp.updateTransactionsStatus(ids, 'unproven')
              })
            }
            log += `  req ${req.id} => unmined\n`
          }
          break
        }

        case 'MINED':
        case 'IMMUTABLE': {
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          // Fetch proof directly from Arcade and complete the transaction
          log += await this.fetchProofFromArcade(req)
          break
        }

        case 'DOUBLE_SPEND_ATTEMPTED': {
          req.status = 'doubleSpend'
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          const ids = req.notify.transactionIds
          if (ids != null) {
            await this.storage.runAsStorageProvider(async sp => {
              await sp.updateTransactionsStatus(ids, 'failed')
            })
          }
          log += `  req ${req.id} => doubleSpend\n`
          break
        }

        case 'REJECTED': {
          req.status = 'invalid'
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          const ids = req.notify.transactionIds
          if (ids != null) {
            await this.storage.runAsStorageProvider(async sp => {
              await sp.updateTransactionsStatus(ids, 'failed')
            })
          }
          log += `  req ${req.id} => invalid\n`
          break
        }

        default:
          log += `  req ${req.id} unhandled status: ${event.txStatus}\n`
          break
      }
    }

    this.monitor.callOnTransactionStatusChanged(event.txid, event.txStatus)

    return log
  }

  /**
   * Fetch the merklePath from Arcade's GET /tx/{txid} endpoint and
   * create a ProvenTx record, completing the transaction.
   */
  private async fetchProofFromArcade (req: EntityProvenTxReq): Promise<string> {
    const arcUrl = (this.monitor.services as Services).options?.arcUrl
    const txid = req.txid
    let log = `  req ${req.id} MINED/IMMUTABLE — fetching proof from Arcade\n`

    try {
      const fetchHeaders: Record<string, string> = {}
      const apiKey = (this.monitor.services as Services).options?.arcConfig?.apiKey
      if (apiKey) {
        fetchHeaders.Authorization = `Bearer ${apiKey}`
      }
      const response = await fetch(`${arcUrl}/tx/${txid}`, { headers: fetchHeaders })
      if (!response.ok) {
        log += `    Arcade GET /tx/${txid} returned ${response.status}\n`
        return log
      }

      const data = await response.json()
      console.log(`[TaskArcadeSSE] GET /tx/${txid}:`, JSON.stringify(data))

      if (!data.merklePath) {
        log += `    No merklePath in response (status=${data.txStatus})\n`
        return log
      }

      // Parse the merklePath hex from Arcade
      const merklePath = MerklePath.fromHex(data.merklePath)
      const merkleRoot = merklePath.computeRoot(txid)

      // Find the leaf to get the tx index
      const leaf = merklePath.path[0].find(l => l.txid === true && l.hash === txid)
      if (leaf == null) {
        log += '    merklePath does not contain leaf for txid\n'
        return log
      }

      const blockHash = data.blockHash || ''
      const height = data.blockHeight || merklePath.blockHeight

      // Create ProvenTx entity
      const now = new Date()
      const ptx = new EntityProvenTx({
        created_at: now,
        updated_at: now,
        provenTxId: 0,
        txid,
        height,
        index: leaf.offset,
        merklePath: merklePath.toBinary(),
        rawTx: req.rawTx,
        merkleRoot,
        blockHash
      })

      // Persist via the same path as TaskCheckForProofs
      await req.refreshFromStorage(this.storage)
      const { provenTxReqId, status, attempts, history } = req.toApi()
      const r = await this.storage.runAsStorageProvider(async sp => {
        return await sp.updateProvenTxReqWithNewProvenTx({
          provenTxReqId,
          status,
          txid,
          attempts,
          history,
          index: leaf.offset,
          height,
          blockHash,
          merklePath: merklePath.toBinary(),
          merkleRoot
        })
      })
      req.status = r.status
      req.apiHistory = r.history
      req.provenTxId = r.provenTxId
      req.notified = true

      this.monitor.callOnProvenTransaction({
        txid,
        txIndex: leaf.offset,
        blockHeight: height,
        blockHash,
        merklePath: merklePath.toBinary(),
        merkleRoot
      })

      log += `    proved at height ${height}, index ${leaf.offset} => ${r.status}\n`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log += `    error fetching proof: ${msg}\n`
      req.addHistoryNote({ when: new Date().toISOString(), what: 'arcProofError', error: msg })
      await req.updateStorageDynamicProperties(this.storage)
    }

    return log
  }
}
