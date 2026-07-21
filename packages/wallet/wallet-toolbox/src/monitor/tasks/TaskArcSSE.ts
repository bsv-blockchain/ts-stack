import { ProvenTxReqTerminalStatus } from '../../sdk/types'
import { EntityProvenTx } from '../../storage/schema/entities'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { ArcSSEClient, ArcSSEEvent } from '../../services/providers/ArcSSEClient'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { Services } from '../../services/Services'
import { TaskUnFail } from './TaskUnFail'

/**
 * Monitor task that receives transaction status updates from Arcade via SSE
 * and processes them — including fetching merkle proofs directly from Arcade
 * when transactions are MINED.
 */
export class TaskArcadeSSE extends WalletMonitorTask {
  static readonly taskName = 'ArcadeSSE'

  sseClient: ArcSSEClient | null = null
  private readonly pendingEvents: ArcSSEEvent[] = []

  constructor (monitor: Monitor) {
    super(monitor, TaskArcadeSSE.taskName)
  }

  override async asyncSetup (): Promise<void> {
    const callbackToken = this.monitor.options.callbackToken
    if (callbackToken == null || callbackToken === '') {
      await this.logSetupEvent('no callbackToken configured; SSE disabled')
      return
    }

    const arcadeUrl = (this.monitor.services as Services).options?.arcadeUrl
    if (arcadeUrl == null || arcadeUrl === '') {
      await this.logSetupEvent('no arcadeUrl configured; SSE disabled')
      return
    }

    const EventSourceClass = this.monitor.options.EventSourceClass
    if (EventSourceClass == null) {
      await this.logSetupEvent('no EventSourceClass provided; SSE disabled')
      return
    }

    let lastEventId: string | undefined
    try {
      lastEventId = await this.monitor.options.loadLastSSEEventId?.()
    } catch (e) {
      await this.logSetupEvent(`failed to load lastEventId: ${stringifyError(e)}`)
    }

    const arcadeApiKey = (this.monitor.services as Services).options?.arcadeConfig?.apiKey

    await this.logSetupEvent(`setting up SSE for arcadeUrl=${arcadeUrl}; lastEventId=${lastEventId ?? '(none)'}`)

    this.sseClient = new ArcSSEClient({
      baseUrl: arcadeUrl,
      callbackToken,
      arcApiKey: arcadeApiKey,
      lastEventId,
      EventSourceClass,
      onEvent: event => {
        this.pendingEvents.push(event)
      },
      onError: err => {
        void this.logSetupEvent(`SSE error: ${err.message}`)
      },
      onLastEventIdChanged: (id: string) => {
        this.monitor.options.saveLastSSEEventId?.(id).catch(e => {
          void this.logSetupEvent(`failed to persist lastEventId: ${stringifyError(e)}`)
        })
      }
    })

    this.sseClient.connect()
  }

  private async logSetupEvent (details: string): Promise<void> {
    try {
      await this.monitor.logEvent(this.name, details)
    } catch {
      // Setup diagnostics must not become a new monitor startup failure path.
    }
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

      const acceptedByNetwork = [
        'SENT_TO_NETWORK',
        'ACCEPTED_BY_NETWORK',
        'SEEN_ON_NETWORK',
        'SEEN_MULTIPLE_NODES'
      ].includes(event.txStatus)
      const confirmedByNetwork = ['MINED', 'IMMUTABLE'].includes(event.txStatus)
      // Arcade can emit REJECTED before another node accepts the same transaction.
      // Permit a later positive network observation to heal requests that an older
      // Monitor version prematurely marked invalid.
      const canRecoverRejectedRequest = req.status === 'invalid' && (acceptedByNetwork || confirmedByNetwork)
      if (ProvenTxReqTerminalStatus.includes(req.status) && !canRecoverRejectedRequest) {
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
        case 'SEEN_ON_NETWORK':
        case 'SEEN_MULTIPLE_NODES': {
          if (['unsent', 'sending', 'callback', 'invalid'].includes(req.status)) {
            const wasInvalid = req.status === 'invalid'
            if (wasInvalid) {
              // Restore transaction state, re-reserve wallet inputs, and verify
              // output spendability using the established unfail repair path.
              log += await new TaskUnFail(this.monitor).unfailReq(req, 4)
            } else if (req.notify.transactionIds != null) {
              await this.storage.runAsStorageProvider(async sp => {
                await sp.updateTransactionsStatus(req.notify.transactionIds ?? [], 'unproven')
              })
            }
            // Apply event state after recovery because the recovery helper
            // refreshes the entity from storage before its atomic update.
            req.status = 'unmined'
            if (wasInvalid) req.attempts = 0
            req.wasBroadcast = true
            req.addHistoryNote(note)
            await req.updateStorageDynamicProperties(this.storage)
            log += `  req ${req.id} => unmined\n`
          }
          break
        }

        case 'MINED':
        case 'IMMUTABLE': {
          if (req.status === 'invalid') {
            log += await new TaskUnFail(this.monitor).unfailReq(req, 4)
            req.status = 'unmined'
            req.attempts = 0
            req.wasBroadcast = true
          }
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          log += await this.fetchProofFromServices(req)
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
          // REJECTED is not a final consensus result: production Arcade has
          // subsequently reported SEEN_MULTIPLE_NODES for the same txid. Keep
          // wallet inputs reserved while proof/rebroadcast processing resolves
          // the transaction authoritatively.
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          log += `  req ${req.id} rejection recorded; awaiting resolution\n`
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
   * Complete a MINED/IMMUTABLE status by using the configured proof providers.
   * Arcade is first when configured, but the shared provider path validates the
   * proof against the wallet chaintracker before a ProvenTx is persisted.
   */
  private async fetchProofFromServices (req: EntityProvenTxReq): Promise<string> {
    const txid = req.txid
    let log = `  req ${req.id} MINED/IMMUTABLE — fetching proof from configured services\n`

    try {
      const proof = await this.monitor.services.getMerklePath(txid)
      const ptx = await EntityProvenTx.fromReq(
        req,
        proof,
        false,
        this.monitor.options.maxRebroadcastAttempts ?? 0
      )
      if (ptx == null) {
        log += `    No validated merkle proof available from ${proof.name ?? 'configured services'}\n`
        return log
      }

      await req.refreshFromStorage(this.storage)
      const { provenTxReqId, status, attempts, history } = req.toApi()
      const { index, height, blockHash, merklePath, merkleRoot } = ptx.toApi()
      const r = await this.storage.runAsStorageProvider(async sp => {
        return await sp.updateProvenTxReqWithNewProvenTx({
          provenTxReqId,
          status,
          txid,
          attempts,
          history,
          index,
          height,
          blockHash,
          merklePath,
          merkleRoot
        })
      })
      req.status = r.status
      req.apiHistory = r.history
      req.provenTxId = r.provenTxId
      if (r.notify != null) req.apiNotify = r.notify
      req.notified = r.notified ?? true
      await req.updateStorageDynamicProperties(this.storage)

      this.monitor.callOnProvenTransaction({
        txid,
        txIndex: index,
        blockHeight: height,
        blockHash,
        merklePath,
        merkleRoot
      })

      log += `    proved by ${proof.name ?? 'configured services'} at height ${height}, index ${index} => ${r.status}\n`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log += `    error fetching proof: ${msg}\n`
      req.addHistoryNote({ when: new Date().toISOString(), what: 'arcProofError', error: msg })
      await req.updateStorageDynamicProperties(this.storage)
    }

    return log
  }
}

function stringifyError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
