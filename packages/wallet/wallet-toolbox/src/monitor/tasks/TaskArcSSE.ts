import { ProvenTxReqTerminalStatus, ReqHistoryNote } from '../../sdk/types'
import { EntityProvenTx } from '../../storage/schema/entities'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { ArcSSEClient, ArcSSEEvent } from '../../services/providers/ArcSSEClient'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { Services } from '../../services/Services'
import { quarantineReqInputs } from '../../storage/methods/reconcileFailedTransactionInputs'

interface ArcadeStatusNote extends ReqHistoryNote {
  when: string
  what: string
  arcStatus: string
  arcTimestamp?: string
  statusCode?: number
  extraInfo?: string
}

interface RejectionClassification {
  terminal: boolean
  inputConflict: boolean
  reqStatus: 'invalid' | 'doubleSpend'
  reason: string
}

/**
 * Monitor task that receives transaction status updates from Arcade via SSE
 * and processes them — including fetching merkle proofs directly from Arcade
 * when transactions are MINED.
 */
export class TaskArcadeSSE extends WalletMonitorTask {
  static readonly taskName = 'ArcadeSSE'

  sseClient: ArcSSEClient | null = null
  private readonly pendingEvents: Array<{ event: ArcSSEEvent, acknowledge: () => void }> = []

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
      onEvent: async event => await new Promise<void>(acknowledge => {
        this.pendingEvents.push({ event, acknowledge })
      }),
      onError: err => {
        void this.logSetupEvent(`SSE error: ${err.message}`)
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
    const eventCount = this.pendingEvents.length
    if (eventCount === 0) return ''

    let log = ''
    for (let i = 0; i < eventCount; i++) {
      // Do not remove or acknowledge an event until its storage work succeeds.
      // A thrown storage error leaves this event at the head for the next run.
      const pending = this.pendingEvents[0]
      log += await this.processStatusEvent(pending.event)
      if (pending.event.eventId != null) {
        try {
          await this.monitor.options.saveLastSSEEventId?.(pending.event.eventId)
        } catch (e) {
          await this.logSetupEvent(`failed to persist lastEventId: ${stringifyError(e)}`)
          throw e
        }
      }
      this.pendingEvents.shift()
      pending.acknowledge()
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
      // A cached in-network label is not stronger than a durable terminal
      // rejection. Only a mined event, followed by validation of its proof,
      // may repair an invalid or double-spend request.
      const canRecoverTerminalRequest = this.canRecoverTerminalRequest(req, event)
      if (ProvenTxReqTerminalStatus.includes(req.status) && !canRecoverTerminalRequest) {
        log += `  req ${req.id} already terminal: ${req.status}\n`
        continue
      }

      const note = {
        when: new Date().toISOString(),
        what: 'arcSSE',
        arcStatus: event.txStatus,
        ...(event.timestamp !== '' ? { arcTimestamp: event.timestamp } : {}),
        ...(event.status != null ? { statusCode: event.status } : {}),
        ...(event.extraInfo != null && event.extraInfo !== '' ? { extraInfo: event.extraInfo.slice(0, 512) } : {})
      }

      log += await this.applyStatusEvent(req, event, note)
    }

    this.monitor.callOnTransactionStatusChanged(event.txid, event.txStatus)

    return log
  }

  private canRecoverTerminalRequest (req: EntityProvenTxReq, event: ArcSSEEvent): boolean {
    const confirmedStatuses = ['MINED', 'IMMUTABLE']
    return (req.status === 'invalid' || req.status === 'doubleSpend') && confirmedStatuses.includes(event.txStatus)
  }

  private async applyStatusEvent (req: EntityProvenTxReq, event: ArcSSEEvent, note: ArcadeStatusNote): Promise<string> {
    switch (event.txStatus) {
      case 'SENT_TO_NETWORK':
      case 'ACCEPTED_BY_NETWORK':
      case 'SEEN_ON_NETWORK':
      case 'SEEN_MULTIPLE_NODES':
        return await this.applyAcceptedStatus(req, note)
      case 'MINED':
      case 'IMMUTABLE':
        return await this.applyMinedStatus(req, note)
      case 'DOUBLE_SPEND_ATTEMPTED':
        return await this.applyDoubleSpendStatus(req, note)
      case 'REJECTED':
        return await this.applyRejectedStatus(req, event, note)
      case 'RECEIVED':
      case 'PENDING_RETRY':
      case 'STUMP_PROCESSING':
      case 'UNKNOWN':
        req.addHistoryNote(note)
        await req.updateStorageDynamicProperties(this.storage)
        return `  req ${req.id} ${event.txStatus} recorded; awaiting resolution\n`
      default:
        return `  req ${req.id} unhandled status: ${event.txStatus}\n`
    }
  }

  private async applyAcceptedStatus (req: EntityProvenTxReq, note: ArcadeStatusNote): Promise<string> {
    if (!['unsent', 'sending', 'callback'].includes(req.status)) return ''

    if (req.notify.transactionIds != null) {
      await this.storage.runAsStorageProvider(async sp => {
        await sp.updateTransactionsStatus(req.notify.transactionIds ?? [], 'unproven')
      })
    }

    req.status = 'unmined'
    req.wasBroadcast = true
    req.addHistoryNote(note)
    await req.updateStorageDynamicProperties(this.storage)
    return `  req ${req.id} => unmined\n`
  }

  private async applyMinedStatus (req: EntityProvenTxReq, note: ArcadeStatusNote): Promise<string> {
    req.addHistoryNote(note)
    await req.updateStorageDynamicProperties(this.storage)
    return await this.fetchProofFromServices(req)
  }

  private async applyDoubleSpendStatus (req: EntityProvenTxReq, note: ArcadeStatusNote): Promise<string> {
    return await this.applyTerminalFailure(req, note, {
      terminal: true,
      inputConflict: true,
      reqStatus: 'doubleSpend',
      reason: 'Arcade reported DOUBLE_SPEND_ATTEMPTED'
    })
  }

  private classifyRejection (event: ArcSSEEvent): RejectionClassification {
    const extraInfo = event.extraInfo?.trim() ?? ''
    const detail = extraInfo.toLowerCase()
    const retryable =
      event.status === 476 ||
      detail.startsWith('parent rejected') ||
      detail.includes('not final') ||
      detail.includes('non-final')
    if (retryable) {
      return {
        terminal: false,
        inputConflict: false,
        reqStatus: 'invalid',
        reason:
          event.status === 476 ? 'transaction is not final' : 'Arcade reported a retryable parent/locktime condition'
      }
    }

    const inputConflict =
      event.status === 462 ||
      event.status === 466 ||
      /(?:utxo|input).*(?:spent|missing|conflict)|missing[- ]inputs?|already spent/.test(detail)
    const classifiedValidatorFailure = event.status != null && event.status >= 460 && event.status <= 475
    const terminal = inputConflict || classifiedValidatorFailure || extraInfo !== ''
    let reason = 'Arcade supplied no durable rejection evidence'
    if (inputConflict) {
      reason = 'Arcade supplied confirmed missing-input/conflict evidence'
    } else if (classifiedValidatorFailure) {
      reason = `Arcade supplied terminal validator code ${String(event.status)}`
    } else if (extraInfo !== '') {
      reason = 'Arcade supplied a terminal validator rejection reason'
    }
    return {
      terminal,
      inputConflict,
      reqStatus: event.status === 466 || inputConflict ? 'doubleSpend' : 'invalid',
      reason
    }
  }

  private async applyRejectedStatus (
    req: EntityProvenTxReq,
    event: ArcSSEEvent,
    note: ArcadeStatusNote
  ): Promise<string> {
    const classification = this.classifyRejection(event)
    if (!classification.terminal) {
      req.addHistoryNote({
        ...note,
        what: 'arcSSERejectionPending',
        reason: classification.reason
      })
      await req.updateStorageDynamicProperties(this.storage)
      return `  req ${req.id} rejection recorded; awaiting resolution\n`
    }
    return await this.applyTerminalFailure(req, note, classification)
  }

  private async applyTerminalFailure (
    req: EntityProvenTxReq,
    note: ArcadeStatusNote,
    classification: RejectionClassification
  ): Promise<string> {
    let quarantined = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
    await this.storage.runAsStorageProvider(async sp => {
      await sp.transaction(async trx => {
        req.status = classification.reqStatus
        req.addHistoryNote({
          ...note,
          what: 'arcSSETerminalRejection',
          reason: classification.reason,
          inputConflict: classification.inputConflict
        })
        await req.updateStorageDynamicProperties(sp, trx)
        const ids = req.notify.transactionIds
        if (ids != null) await sp.updateTransactionsStatus(ids, 'failed', trx)
        if (classification.inputConflict) {
          quarantined = await quarantineReqInputs(req, sp, trx)
          req.addHistoryNote({
            when: new Date().toISOString(),
            what: 'arcSSEInputQuarantine',
            checked: quarantined.checked,
            confirmed: quarantined.staleConfirmed,
            ...(quarantined.staleOutpoints.length > 0 ? { outpoints: quarantined.staleOutpoints.join(',') } : {})
          })
          await req.updateStorageDynamicProperties(sp, trx)
        }
      })
    })
    return `  req ${req.id} => ${classification.reqStatus}; quarantined ${quarantined.staleConfirmed} local input copy/copies\n`
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
