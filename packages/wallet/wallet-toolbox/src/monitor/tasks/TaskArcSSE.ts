import { promiseFromSync, awaitFromSync, awaitVoidFromSync } from '../../utility/promiseFromSync'
import { WalletError } from '../../sdk/WalletError'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import { StorageReqWrite } from '../../storage/StorageReqWrite'
import { ProvenTxReqTerminalStatus, ReqHistoryNote } from '../../sdk/types'
import { EntityProvenTx } from '../../storage/schema/entities'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { ArcSSEClient, ArcSSEEvent } from '../../services/providers/ArcSSEClient'
import { Monitor } from '../Monitor'
import { WalletMonitorTask, captureMonitorReqWrite } from './WalletMonitorTask'
import { Services } from '../../services/Services'
import {
  quarantineReqInputs,
  applyCapturedTerminalFailure,
  failPendingDescendants,
  failCapturedPendingDescendants
} from '../../storage/methods/reconcileFailedTransactionInputs'
import { classifyArcadeRejection, type ArcadeRejectionClassification } from '../../services/providers/arcadeStatus'
import { safeDiagnostic } from '../../services/chaintracker/chaintracks/util/safeDiagnostic'
import { getCanonicalMerklePath } from '../../services/getCanonicalMerklePath'

interface ArcadeStatusNote extends ReqHistoryNote {
  when: string
  what: string
  arcStatus: string
  arcTimestamp?: string
  statusCode?: number
  extraInfo?: string
}

/**
 * Monitor task that receives transaction status updates from Arcade via SSE
 * and processes them — including fetching merkle proofs directly from Arcade
 * when transactions are MINED.
 */
export class TaskArcadeSSE extends WalletMonitorTask {
  static readonly taskName = 'ArcadeSSE'

  sseClient: ArcSSEClient | null = null
  private readonly pendingEvents: Array<{
    event: ArcSSEEvent
    acknowledge: () => void
    reject: (error: Error) => void
  }> = []

  constructor(monitor: Monitor) {
    super(monitor, TaskArcadeSSE.taskName)
  }

  override async asyncSetup(): Promise<void> {
    if (this.sseClient != null) return
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
      await this.logSetupEvent(`failed to load lastEventId: ${safeDiagnostic(e)}`)
    }

    const arcadeApiKey = (this.monitor.services as Services).options?.arcadeConfig?.apiKey

    await this.logSetupEvent('setting up configured Arcade SSE endpoint')

    this.sseClient = new ArcSSEClient({
      baseUrl: arcadeUrl,
      callbackToken,
      arcApiKey: arcadeApiKey,
      lastEventId,
      EventSourceClass,
      onEvent: event =>
        awaitFromSync(
          () =>
            new Promise<void>((acknowledge, reject) => {
              // ArcSSEClient waits for this promise before dispatching the next
              // event. Keep an independent one-item bound in case a replacement
              // client violates that contract.
              if (this.pendingEvents.length > 0) {
                reject(new Error('Arcade SSE monitor event capacity was exceeded.'))
                return
              }
              this.pendingEvents.push({ event: { ...event }, acknowledge, reject })
            })
        ),
      onError: err => {
        void this.logSetupEvent(`SSE error: ${safeDiagnostic(err)}`)
      }
    })

    this.sseClient.connect()
  }

  private async logSetupEvent(details: string): Promise<void> {
    try {
      await this.monitor.logEvent(this.name, details)
    } catch {
      // Setup diagnostics must not become a new monitor startup failure path.
    }
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: this.pendingEvents.length > 0 }
  }

  async runTask(): Promise<string> {
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
          await this.logSetupEvent(`failed to persist lastEventId: ${safeDiagnostic(e)}`)
          throw e
        }
      }
      this.pendingEvents.shift()
      pending.acknowledge()
    }
    return log
  }

  async fetchNow(): Promise<number> {
    if (this.sseClient == null) return 0
    return await this.sseClient.fetchEvents()
  }

  /** Close the live stream and reject any unacknowledged monitor event. */
  close(): void {
    this.sseClient?.close()
    this.sseClient = null
    const error = new Error('Arcade SSE monitor task closed.')
    for (const pending of this.pendingEvents.splice(0)) pending.reject(error)
  }

  private async processStatusEvent(event: ArcSSEEvent): Promise<string> {
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

      try {
        const writes = await captureMonitorReqWrite(this, [req.txid], true)
        await writes?.assertCurrent()
        log += await this.applyStatusEvent(req, event, note, writes)
      } catch (error) {
        if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
        // The current primary polls/reconciles durable requests independently.
        // An inactive profile must not block the service-wide SSE stream.
        log += `  req ${req.id} deferred to its current primary; no financial completion acknowledged\n`
      }
    }

    this.monitor.callOnTransactionStatusChanged(event.txid, event.txStatus)

    return log
  }

  private async record(
    req: EntityProvenTxReq,
    writes: StorageReqWrite | undefined,
    apply: (current: EntityProvenTxReq) => void | false
  ): Promise<void> {
    if (writes == null) {
      if (apply(req) !== false) await req.updateStorageDynamicProperties(this.storage)
    } else if (!(await writes.request(req, current => promiseFromSync(() => apply(current))))) {
      throw new WERR_NOT_ACTIVE('SSE observation lost its captured primary profiles')
    }
  }

  private canRecoverTerminalRequest(req: EntityProvenTxReq, event: ArcSSEEvent): boolean {
    const confirmedStatuses = ['MINED', 'IMMUTABLE']
    return (req.status === 'invalid' || req.status === 'doubleSpend') && confirmedStatuses.includes(event.txStatus)
  }

  private async applyStatusEvent(
    req: EntityProvenTxReq,
    event: ArcSSEEvent,
    note: ArcadeStatusNote,
    writes?: StorageReqWrite
  ): Promise<string> {
    switch (event.txStatus) {
      case 'SENT_TO_NETWORK':
      case 'ACCEPTED_BY_NETWORK':
      case 'SEEN_ON_NETWORK':
      case 'SEEN_MULTIPLE_NODES':
        return await this.applyAcceptedStatus(req, note, writes)
      case 'MINED':
      case 'IMMUTABLE':
        return await this.applyMinedStatus(req, note, writes)
      case 'DOUBLE_SPEND_ATTEMPTED':
      case 'SEEN_IN_ORPHAN_MEMPOOL':
        return await this.applyDoubleSpendStatus(req, event, note, writes)
      case 'REJECTED':
        return await this.applyRejectedStatus(req, event, note, writes)
      case 'RECEIVED':
      case 'PENDING_RETRY':
      case 'STUMP_PROCESSING':
      case 'UNKNOWN':
        await this.record(req, writes, current => {
          current.addHistoryNote(note)
        })
        return `  req ${req.id} ${event.txStatus} recorded; awaiting resolution\n`
      default:
        return `  req ${req.id} unhandled status: ${event.txStatus}\n`
    }
  }

  private async applyAcceptedStatus(
    req: EntityProvenTxReq,
    note: ArcadeStatusNote,
    writes?: StorageReqWrite
  ): Promise<string> {
    if (!['unsent', 'sending', 'callback'].includes(req.status)) return ''

    if (writes != null) {
      let accepted = false
      await this.record(req, writes, current => {
        if (!['unsent', 'sending', 'callback'].includes(current.status)) return false
        current.status = 'unmined'
        current.wasBroadcast = true
        current.notified = false
        current.addHistoryNote(note)
        accepted = true
      })
      if (accepted) await writes.status(req, 'unproven')
      return `  req ${req.id} => ${req.status}\n`
    }

    if (req.notify.transactionIds != null) {
      await this.storage.runAsStorageProvider(sp =>
        awaitVoidFromSync(() => sp.updateTransactionsStatus(req.notify.transactionIds ?? [], 'unproven'))
      )
    }

    req.status = 'unmined'
    req.wasBroadcast = true
    req.addHistoryNote(note)
    await req.updateStorageDynamicProperties(this.storage)
    return `  req ${req.id} => unmined\n`
  }

  private async applyMinedStatus(
    req: EntityProvenTxReq,
    note: ArcadeStatusNote,
    writes?: StorageReqWrite
  ): Promise<string> {
    await this.record(req, writes, current => {
      current.addHistoryNote(note)
    })
    return await this.fetchProofFromServices(req, writes)
  }

  private applyDoubleSpendStatus(
    req: EntityProvenTxReq,
    event: ArcSSEEvent,
    note: ArcadeStatusNote,
    writes?: StorageReqWrite
  ): Promise<string> {
    return awaitFromSync(() => this.applyTerminalFailure(req, note, classifyArcadeRejection(event), writes))
  }

  private classifyRejection(event: ArcSSEEvent): ArcadeRejectionClassification {
    return classifyArcadeRejection(event)
  }

  private async applyRejectedStatus(
    req: EntityProvenTxReq,
    event: ArcSSEEvent,
    note: ArcadeStatusNote,
    writes?: StorageReqWrite
  ): Promise<string> {
    const classification = this.classifyRejection(event)
    if (!classification.terminal) {
      await this.record(req, writes, current => {
        current.addHistoryNote({ ...note, what: 'arcSSERejectionPending', reason: classification.reason })
      })
      return `  req ${req.id} rejection recorded; awaiting resolution\n`
    }
    return await this.applyTerminalFailure(req, note, classification, writes)
  }

  private async applyTerminalFailure(
    req: EntityProvenTxReq,
    note: ArcadeStatusNote,
    classification: ArcadeRejectionClassification,
    writes?: StorageReqWrite
  ): Promise<string> {
    if (writes != null) {
      let terminal = false
      await this.record(req, writes, current => {
        if (current.status === 'completed' || current.provenTxId != null) return false
        current.status = classification.reqStatus
        current.notified = false
        current.addHistoryNote({
          ...note,
          what: 'arcSSETerminalRejection',
          reason: classification.reason,
          inputConflict: classification.inputConflict
        })
        terminal = true
      })
      if (!terminal) return `  req ${req.id} retained advanced proof state\n`
      const provider = await this.storage.runAsStorageProvider(sp => promiseFromSync(() => sp))
      const quarantined = await applyCapturedTerminalFailure(req, provider, writes, classification.inputConflict, [], {
        extraInfo: note.extraInfo
      })
      if (classification.inputConflict)
        await this.record(req, writes, current => {
          current.addHistoryNote({
            when: new Date().toISOString(),
            what: 'arcSSEInputQuarantine',
            checked: quarantined.checked,
            confirmed: quarantined.staleConfirmed,
            ...(quarantined.staleOutpoints.length ? { outpoints: quarantined.staleOutpoints.join(',') } : {})
          })
        })
      const descendants = await failCapturedPendingDescendants([req.txid], provider, writes)
      for (const txid of descendants) this.monitor.callOnTransactionStatusChanged(txid, 'REJECTED')
      return `  req ${req.id} => ${req.status}; quarantined ${quarantined.staleConfirmed} local input copy/copies\n`
    }

    let quarantined = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
    let descendants: string[] = []
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
          quarantined = await quarantineReqInputs(req, sp, trx, undefined, { extraInfo: note.extraInfo })
          req.addHistoryNote({
            when: new Date().toISOString(),
            what: 'arcSSEInputQuarantine',
            checked: quarantined.checked,
            confirmed: quarantined.staleConfirmed,
            ...(quarantined.staleOutpoints.length > 0 ? { outpoints: quarantined.staleOutpoints.join(',') } : {})
          })
          await req.updateStorageDynamicProperties(sp, trx)
        }
        descendants = await failPendingDescendants([req.txid], sp, trx)
      })
    })
    for (const txid of descendants) this.monitor.callOnTransactionStatusChanged(txid, 'REJECTED')
    return (
      `  req ${req.id} => ${classification.reqStatus}; quarantined ${quarantined.staleConfirmed} local input copy/copies\n` +
      (descendants.length > 0 ? `  failed ${descendants.length} pending descendant(s): ${descendants.join(',')}\n` : '')
    )
  }

  /**
   * Complete a MINED/IMMUTABLE status by using the configured proof providers.
   * Arcade is first when configured, but the shared provider path validates the
   * proof against the wallet chaintracker before a ProvenTx is persisted.
   */
  private async fetchProofFromServices(req: EntityProvenTxReq, writes?: StorageReqWrite): Promise<string> {
    const txid = req.txid
    let log = `  req ${req.id} MINED/IMMUTABLE — fetching proof from configured services\n`

    try {
      // The event's original capture spans note persistence and proof lookup.
      await writes?.assertCurrent()
      const proof = await getCanonicalMerklePath(
        this.monitor.services,
        this.monitor.chaintracksWithEvents || this.monitor.chaintracks,
        txid
      )
      const ptx = await EntityProvenTx.fromReq(
        req,
        proof,
        false,
        this.monitor.options.maxRebroadcastAttempts ?? 0,
        this.monitor.chaintracks
      )
      if (ptx == null) {
        log += `    No validated merkle proof available from ${proof.name ?? 'configured services'}\n`
        return log
      }

      if (writes != null) {
        const observation = req.toApi()
        await this.record(req, writes, current => {
          current.mergeHistory(observation, undefined, true)
        })
      } else await req.refreshFromStorage(this.storage)
      const { provenTxReqId, status, attempts, history } = req.toApi()
      const { index, height, blockHash, merklePath, merkleRoot } = ptx.toApi()
      const args = {
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
      }
      const complete = async (sp: import('../../storage/StorageProvider').StorageProvider) =>
        writes == null
          ? await sp.updateProvenTxReqWithNewProvenTx(args)
          : await sp.updateProvenTxReqWithNewProvenTx(args, undefined, writes)
      const r =
        writes?.preparesOutsideManager === true
          ? await writes.prepare(complete)
          : await this.storage.runAsStorageProvider(complete)

      req.status = r.status
      req.apiHistory = r.history
      req.provenTxId = r.provenTxId
      if (r.notify != null) req.apiNotify = r.notify
      req.notified = r.notified ?? true
      if (writes == null) await req.updateStorageDynamicProperties(this.storage)

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
      const msg = safeDiagnostic(err)
      log += `    error fetching proof: ${msg}\n`
      await this.record(req, writes, current => {
        current.addHistoryNote({ when: new Date().toISOString(), what: 'arcProofError', error: msg })
      })
    }

    return log
  }
}
