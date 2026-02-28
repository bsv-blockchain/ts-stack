import { ProvenTxReqTerminalStatus } from '../../sdk/types'
import { EntityProvenTxReq } from '../../storage/schema/entities/EntityProvenTxReq'
import { ArcSSEClient, ArcSSEEvent } from '../../services/providers/ArcSSEClient'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'
import { TaskCheckForProofs } from './TaskCheckForProofs'

/**
 * Monitor task that manages an SSE connection to Arcade for real-time
 * transaction status updates.
 *
 * Events are queued by the SSE callback and processed on each monitor cycle.
 * On MINED events, triggers TaskCheckForProofs to fetch merkle proofs.
 */
export class TaskArcSSE extends WalletMonitorTask {
  static taskName = 'ArcSSE'

  private sseClient: ArcSSEClient | null = null
  private pendingEvents: ArcSSEEvent[] = []

  constructor(monitor: Monitor) {
    super(monitor, TaskArcSSE.taskName)
  }

  override async asyncSetup(): Promise<void> {
    const callbackToken = this.monitor.options.callbackToken
    if (!callbackToken) return

    const arcUrl = this.monitor.services.options.arcUrl
    if (!arcUrl) return

    this.sseClient = new ArcSSEClient({
      baseUrl: arcUrl,
      callbackToken,
      onEvent: (event) => {
        this.pendingEvents.push(event)
      },
      onConnected: () => {
        console.log(`[TaskArcSSE] SSE connected to ${arcUrl}`)
      },
      onDisconnected: () => {
        console.log(`[TaskArcSSE] SSE disconnected`)
      },
      onError: () => {
        // Reconnection is handled by ArcSSEClient internally
      }
    })

    this.sseClient.connect()
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: this.pendingEvents.length > 0 }
  }

  async runTask(): Promise<string> {
    const events = this.pendingEvents.splice(0)
    if (events.length === 0) return ''

    let log = ''
    for (const event of events) {
      log += await this.processStatusEvent(event)
    }
    return log
  }

  pause(): void {
    this.sseClient?.pause()
  }

  resume(): void {
    this.sseClient?.resume()
  }

  private async processStatusEvent(event: ArcSSEEvent): Promise<string> {
    let log = `SSE: txid=${event.txid} status=${event.txStatus}\n`

    const reqs = await this.storage.findProvenTxReqs({
      partial: { txid: event.txid }
    })

    if (reqs.length === 0) {
      log += `  No matching ProvenTxReq\n`
      return log
    }

    for (const reqApi of reqs) {
      const req = new EntityProvenTxReq(reqApi)

      // Don't downgrade terminal statuses
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
            // Update associated transaction records
            const ids = req.notify.transactionIds
            if (ids) {
              await this.storage.runAsStorageProvider(async sp => {
                await sp.updateTransactionsStatus(ids, 'unproven')
              })
            }
            log += `  req ${req.id} => unmined\n`
          }
          break
        }

        case 'MINED': {
          // Trigger proof fetching — TaskCheckForProofs handles creating
          // ProvenTx records and advancing to 'completed' properly.
          TaskCheckForProofs.checkNow = true
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          log += `  req ${req.id} MINED — triggered proof check\n`
          break
        }

        case 'DOUBLE_SPEND_ATTEMPTED': {
          req.status = 'doubleSpend'
          req.addHistoryNote(note)
          await req.updateStorageDynamicProperties(this.storage)
          const ids = req.notify.transactionIds
          if (ids) {
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
          if (ids) {
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

    // Notify listener of status change
    this.monitor.callOnTransactionStatusChanged(event.txid, event.txStatus)

    return log
  }
}
