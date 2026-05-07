import { Transaction } from '@bsv/sdk'
import * as sdk from '../../sdk/index'
import { Format } from '../../utility/Format'
import { Services } from '../../services/Services'
import { MonitorDaemon } from '../../monitor/MonitorDaemon'
import { Wallet } from '../../Wallet'
import { renderAdminPage } from './adminUi'
import path from 'node:path'

const express = require('express')
const { createAuthMiddleware } = require('@bsv/auth-express-middleware')

export interface MonitorAdminContextConfig {
  chain: sdk.Chain
  adminPort?: number
  adminHost: string
  adminIdentityKeys: string[]
}

export interface MonitorAdminContext {
  config: MonitorAdminContextConfig
  daemon: MonitorDaemon
  authWallet?: Wallet
}

interface ReqRow {
  updated_at: Date | string
  req_created_at: Date | string
  tx_created_at?: Date | string
  minutesOld: number
  hoursOld: number
  provenTxReqId: number
  transactionId?: number
  userId?: number
  txid: string
  provenTxId?: number
  reqStatus: string
  txStatus?: string
  satoshis?: number
  attempts: number
  notified: boolean
  history: string
  notify: string
  rawTxHex?: string
  batch?: string
  inputBeefHex?: string
}

function asNumber (value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function toHex (value?: number[] | Buffer): string | undefined {
  if (value == null) return undefined
  if (Buffer.isBuffer(value)) return value.toString('hex')
  return Buffer.from(value).toString('hex')
}

interface AdminStatsLike {
  requestedBy?: unknown
  when?: unknown
  usersDay?: unknown
  usersWeek?: unknown
  usersMonth?: unknown
  usersTotal?: unknown
  satoshisDefaultDay?: unknown
  satoshisDefaultWeek?: unknown
  satoshisDefaultMonth?: unknown
  satoshisDefaultTotal?: unknown
  satoshisOtherDay?: unknown
  satoshisOtherWeek?: unknown
  satoshisOtherMonth?: unknown
  satoshisOtherTotal?: unknown
  labelsDay?: unknown
  labelsWeek?: unknown
  labelsMonth?: unknown
  labelsTotal?: unknown
  tagsDay?: unknown
  tagsWeek?: unknown
  tagsMonth?: unknown
  tagsTotal?: unknown
  basketsDay?: unknown
  basketsWeek?: unknown
  basketsMonth?: unknown
  basketsTotal?: unknown
  transactionsDay?: unknown
  transactionsWeek?: unknown
  transactionsMonth?: unknown
  transactionsTotal?: unknown
  txCompletedDay?: unknown
  txCompletedWeek?: unknown
  txCompletedMonth?: unknown
  txCompletedTotal?: unknown
  txFailedDay?: unknown
  txFailedWeek?: unknown
  txFailedMonth?: unknown
  txFailedTotal?: unknown
  txAbandonedDay?: unknown
  txAbandonedWeek?: unknown
  txAbandonedMonth?: unknown
  txAbandonedTotal?: unknown
  txNosendDay?: unknown
  txNosendWeek?: unknown
  txNosendMonth?: unknown
  txNosendTotal?: unknown
  txUnprovenDay?: unknown
  txUnprovenWeek?: unknown
  txUnprovenMonth?: unknown
  txUnprovenTotal?: unknown
  txSendingDay?: unknown
  txSendingWeek?: unknown
  txSendingMonth?: unknown
  txSendingTotal?: unknown
  txUnprocessedDay?: unknown
  txUnprocessedWeek?: unknown
  txUnprocessedMonth?: unknown
  txUnprocessedTotal?: unknown
  txUnsignedDay?: unknown
  txUnsignedWeek?: unknown
  txUnsignedMonth?: unknown
  txUnsignedTotal?: unknown
  txNonfinalDay?: unknown
  txNonfinalWeek?: unknown
  txNonfinalMonth?: unknown
  txNonfinalTotal?: unknown
  txUnfailDay?: unknown
  txUnfailWeek?: unknown
  txUnfailMonth?: unknown
  txUnfailTotal?: unknown
}

function prettyJson (value?: string): string | undefined {
  if (!value) return undefined
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function alignLeft (value: unknown, width: number): string {
  const text = String(value)
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

function alignRight (value: unknown, width: number): string {
  const text = String(value)
  return text.length > width ? `…${text.slice(-width + 1)}` : text.padStart(width)
}

function toAdminStatsLog (stats: AdminStatsLike): string {
  const row = (label: string, day: unknown, week: unknown, month: unknown, total: unknown) =>
    `  ${alignLeft(label, 13)} ${alignRight(day ?? '', 18)} ${alignRight(week ?? '', 18)} ${alignRight(month ?? '', 18)} ${alignRight(total ?? '', 18)}\n`

  let log = `StorageAdminStats: ${String(stats.when ?? '')} ${String(stats.requestedBy ?? '')}\n`
  log += `  ${alignLeft('', 13)} ${alignRight('Day', 18)} ${alignRight('Week', 18)} ${alignRight('Month', 18)} ${alignRight('Total', 18)}\n`
  log += row('users', stats.usersDay, stats.usersWeek, stats.usersMonth, stats.usersTotal)
  log += row(
    'change sats',
    formatSatoshis(stats.satoshisDefaultDay),
    formatSatoshis(stats.satoshisDefaultWeek),
    formatSatoshis(stats.satoshisDefaultMonth),
    formatSatoshis(stats.satoshisDefaultTotal)
  )
  log += row(
    'other sats',
    formatSatoshis(stats.satoshisOtherDay),
    formatSatoshis(stats.satoshisOtherWeek),
    formatSatoshis(stats.satoshisOtherMonth),
    formatSatoshis(stats.satoshisOtherTotal)
  )
  log += row('labels', stats.labelsDay, stats.labelsWeek, stats.labelsMonth, stats.labelsTotal)
  log += row('tags', stats.tagsDay, stats.tagsWeek, stats.tagsMonth, stats.tagsTotal)
  log += row('baskets', stats.basketsDay, stats.basketsWeek, stats.basketsMonth, stats.basketsTotal)
  log += row(
    'transactions',
    stats.transactionsDay,
    stats.transactionsWeek,
    stats.transactionsMonth,
    stats.transactionsTotal
  )
  log += row('completed', stats.txCompletedDay, stats.txCompletedWeek, stats.txCompletedMonth, stats.txCompletedTotal)
  log += row('failed', stats.txFailedDay, stats.txFailedWeek, stats.txFailedMonth, stats.txFailedTotal)
  log += row('abandoned', stats.txAbandonedDay, stats.txAbandonedWeek, stats.txAbandonedMonth, stats.txAbandonedTotal)
  log += row('nosend', stats.txNosendDay, stats.txNosendWeek, stats.txNosendMonth, stats.txNosendTotal)
  log += row('unproven', stats.txUnprovenDay, stats.txUnprovenWeek, stats.txUnprovenMonth, stats.txUnprovenTotal)
  log += row('sending', stats.txSendingDay, stats.txSendingWeek, stats.txSendingMonth, stats.txSendingTotal)
  log += row(
    'unprocessed',
    stats.txUnprocessedDay,
    stats.txUnprocessedWeek,
    stats.txUnprocessedMonth,
    stats.txUnprocessedTotal
  )
  log += row('unsigned', stats.txUnsignedDay, stats.txUnsignedWeek, stats.txUnsignedMonth, stats.txUnsignedTotal)
  log += row('nonfinal', stats.txNonfinalDay, stats.txNonfinalWeek, stats.txNonfinalMonth, stats.txNonfinalTotal)
  log += row('unfail', stats.txUnfailDay, stats.txUnfailWeek, stats.txUnfailMonth, stats.txUnfailTotal)
  return log
}

function formatSatoshis (value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0)
  return Format.satoshis(Number.isFinite(n) ? n : 0)
}

function parseJson (value?: string): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function decodeRawTx (rawTx?: number[]) {
  if (rawTx == null) return undefined
  const tx = Transaction.fromBinary(rawTx)
  return {
    txid: tx.id('hex'),
    version: tx.version,
    lockTime: tx.lockTime,
    inputs: tx.inputs.map((input: any, vin: number) => ({
      vin,
      sourceTXID: input.sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sequence: input.sequence,
      unlockingScriptLength: input.unlockingScript?.toBinary?.().length
    })),
    outputs: tx.outputs.map((output: any, vout: number) => ({
      vout,
      satoshis: Number(output.satoshis),
      lockingScriptHex: output.lockingScript?.toHex?.()
    }))
  }
}

async function getStorage (context: MonitorAdminContext) {
  const storage = context.daemon.setup?.storageProvider
  if (storage == null) throw new Error('Monitor storage provider is not available.')
  return storage
}

async function getKnex (context: MonitorAdminContext) {
  const storage = await getStorage(context)
  const knex = (storage as any).knex
  if (!knex) throw new Error('Joined admin review requires StorageKnex / MySQL.')
  return knex
}

async function queryReqReview (context: MonitorAdminContext, query: Record<string, unknown>) {
  const knex = await getKnex(context)
  const status = typeof query.status === 'string' && query.status.trim() ? query.status.trim() : undefined
  const txid = typeof query.txid === 'string' && query.txid.trim() ? query.txid.trim() : undefined
  const batch = typeof query.batch === 'string' && query.batch.trim() ? query.batch.trim() : undefined
  const userId = typeof query.userId === 'string' && query.userId.trim() ? asNumber(query.userId, 0) : undefined
  const minTransactionId = asNumber(query.minTransactionId, 0)
  const limit = Math.min(asNumber(query.limit, 25), 200)
  const offset = Math.max(asNumber(query.offset, 0), 0)

  const base = knex('proven_tx_reqs as r')
    .join('transactions as t', 't.txid', 'r.txid')
    .where('t.transactionId', '>=', minTransactionId)

  if (status) base.andWhere('r.status', status)
  if (txid) base.andWhere('r.txid', txid)
  if (batch) base.andWhere('r.batch', batch)
  if (userId) base.andWhere('t.userId', userId)

  const totalResult = (await base.clone().count({ count: '*' })) as Array<{ count: number | string }>
  const total = Number(totalResult[0]?.count || 0)

  const rows = (await base
    .clone()
    .select([
      'r.updated_at',
      'r.created_at as req_created_at',
      't.created_at as tx_created_at',
      knex.raw('TIMESTAMPDIFF(MINUTE, r.created_at, NOW()) as minutesOld'),
      knex.raw('TIMESTAMPDIFF(HOUR, r.created_at, NOW()) as hoursOld'),
      'r.provenTxReqId',
      't.transactionId',
      't.userId',
      'r.txid',
      'r.provenTxId',
      'r.status as reqStatus',
      't.status as txStatus',
      't.satoshis',
      'r.attempts',
      'r.notified',
      'r.history',
      'r.notify',
      knex.raw('HEX(r.rawTx) as rawTxHex'),
      'r.batch',
      knex.raw('HEX(r.inputBEEF) as inputBeefHex')
    ])
    .orderBy('r.provenTxReqId', 'desc')
    .limit(limit)
    .offset(offset)) as ReqRow[]

  return {
    total,
    rows: rows.map(row => ({
      ...row,
      historyJson: parseJson(row.history),
      notifyJson: parseJson(row.notify),
      historyPretty: prettyJson(row.history),
      notifyPretty: prettyJson(row.notify)
    }))
  }
}

function normalizeReviewMode (value: unknown): 'all' | 'change' {
  return value === 'change' ? 'change' : 'all'
}

function getReviewUtxosTask (context: MonitorAdminContext): {
  reviewByIdentityKey: (identityKey: string, mode: 'all' | 'change') => Promise<string>
} {
  const monitor = context.daemon.setup?.monitor
  if (monitor == null) throw new Error('Monitor is not available.')

  const task = [...monitor._tasks, ...monitor._otherTasks].find(item => item.name === 'ReviewUtxos') as
    | { reviewByIdentityKey?: (identityKey: string, mode: 'all' | 'change') => Promise<string> }
    | undefined

  if ((task?.reviewByIdentityKey) == null) {
    throw new Error('ReviewUtxos task is not available in this monitor runtime.')
  }

  return {
    reviewByIdentityKey: task.reviewByIdentityKey.bind(task)
  }
}

async function queryUsers (context: MonitorAdminContext, query: Record<string, unknown>) {
  const storage = await getStorage(context)
  const search = typeof query.search === 'string' ? query.search.trim() : ''
  const limit = Math.min(Math.max(asNumber(query.limit, 50), 1), 200)
  const users = await storage.recentlyActiveUsers(search ? 200 : limit)

  const filtered = search
    ? users.filter(
      user => user.identityKey.includes(search) || (user.userId !== undefined && String(user.userId).includes(search))
    )
    : users

  return {
    total: filtered.length,
    users: filtered.slice(0, limit).map(user => ({
      userId: user.userId,
      identityKey: user.identityKey,
      isActive: user.activeStorage
    }))
  }
}

async function resolveIdentityKeyFromInput (context: MonitorAdminContext, userInput: string): Promise<string> {
  const value = userInput.trim()
  if (!value) throw new Error('identityKey or userId is required.')

  if (value.length < 64) {
    const storage = await getStorage(context)
    const userId = asNumber(value, -1)
    if (userId < 0) throw new Error('userId must be a valid integer.')
    const user = (await storage.findUsers({ partial: { userId } }))[0]
    if (!user?.identityKey) throw new Error(`User ${userId} was not found.`)
    return user.identityKey
  }

  return value
}

async function queryMonitorCallHistory (context: MonitorAdminContext, query: Record<string, unknown>) {
  const storage = await getStorage(context)
  const limit = Math.min(Math.max(asNumber(query.limit, 120), 1), 120)
  const offset = Math.max(asNumber(query.offset, 0), 0)
  const selectedId = asNumber(query.selectedId, -1)

  const partial = { event: 'MonitorCallHistory' as const }
  const [events, total] = await Promise.all([
    storage.findMonitorEvents({ partial, orderDescending: true, paged: { limit, offset } }),
    storage.countMonitorEvents({ partial })
  ])

  const mapped = events.map(event => ({
    id: event.id,
    created_at: event.created_at,
    updated_at: event.updated_at,
    event: event.event,
    detailsJson: parseJson(event.details),
    detailsPretty: prettyJson(event.details)
  }))

  const selected = mapped.find(event => event.id === selectedId) || mapped[0] || null

  return {
    total,
    offset,
    limit,
    selectedId: selected?.id,
    hasNewer: offset > 0,
    hasOlder: offset + mapped.length < total,
    events: mapped,
    selected
  }
}

async function reviewUtxosByIdentityKey (
  context: MonitorAdminContext,
  requestedBy: string,
  userInput: string,
  mode: 'all' | 'change'
) {
  const storage = await getStorage(context)
  const task = getReviewUtxosTask(context)
  const identityKey = await resolveIdentityKeyFromInput(context, userInput)
  const log = await task.reviewByIdentityKey(identityKey, mode)

  await storage.insertMonitorEvent({
    created_at: new Date(),
    updated_at: new Date(),
    id: 0,
    event: 'AdminReviewUtxos',
    details: JSON.stringify({ requestedBy, identityKey, mode, log })
  })

  return {
    requestedBy,
    identityKey,
    mode,
    log
  }
}

async function getReqDetail (context: MonitorAdminContext, provenTxReqId: number) {
  const storage = await getStorage(context)
  const req = (await storage.findProvenTxReqs({ partial: { provenTxReqId } }))[0]
  if (!req) throw new Error(`ProvenTxReq ${provenTxReqId} not found`)

  const txs = req.txid
    ? await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: false, orderDescending: true })
    : []

  return {
    req,
    reqHistory: parseJson(req.history),
    reqNotify: parseJson(req.notify),
    rawTxHex: toHex(req.rawTx),
    inputBeefHex: toHex(req.inputBEEF),
    decodedRawTx: decodeRawTx(req.rawTx),
    transactions: txs.map(tx => ({
      ...tx,
      rawTxHex: toHex(tx.rawTx),
      inputBeefHex: toHex(tx.inputBEEF)
    }))
  }
}

async function rebroadcastReq (
  context: MonitorAdminContext,
  provenTxReqId: number,
  provider: string,
  requestedBy: string
) {
  const storage = await getStorage(context)
  const req = (await storage.findProvenTxReqs({ partial: { provenTxReqId } }))[0]
  if (!req?.rawTx) throw new Error(`ProvenTxReq ${provenTxReqId} is missing rawTx`)

  const services = context.daemon.setup?.services
  if (!(services instanceof Services)) {
    throw new TypeError('Manual rebroadcast requires monitor services to be a Services instance.')
  }

  const rawTxHex = toHex(req.rawTx)!
  let result: unknown

  switch (provider) {
    case 'taal':
      result = await services.arcTaal.postRawTx(rawTxHex, [req.txid])
      break
    case 'woc':
      result = await services.whatsonchain.postRawTx(rawTxHex)
      break
    default:
      throw new Error(`Unsupported provider "${provider}". Use "taal" or "woc".`)
  }

  await storage.insertMonitorEvent({
    created_at: new Date(),
    updated_at: new Date(),
    id: 0,
    event: 'AdminRebroadcast',
    details: JSON.stringify({ requestedBy, provider, provenTxReqId, txid: req.txid, result })
  })

  return {
    provider,
    provenTxReqId,
    txid: req.txid,
    rawTxHex,
    result
  }
}

export class AdminServer {
  private readonly app: any
  private server: any

  constructor (private readonly context: MonitorAdminContext) {
    this.app = express()
    this.setupRoutes()
  }

  private getSdkBundlePath (): string {
    const sdkMainPath = require.resolve('@bsv/sdk')
    return path.resolve(path.dirname(sdkMainPath), '../umd/bundle.js')
  }

  private setupRoutes (): void {
    this.app.use(express.json({ limit: '5mb' }))
    this.app.use((req: any, res: any, next: any) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', '*')
      res.header('Access-Control-Allow-Methods', '*')
      if (req.method === 'OPTIONS') return res.sendStatus(200)
      next()
    })

    this.app.get('/healthz', (_req: any, res: any) => {
      res.json({ ok: true, chain: this.context.config.chain })
    })

    this.app.get('/admin/assets/bsv-sdk.js', (_req: any, res: any) => {
      res.type('application/javascript').sendFile(this.getSdkBundlePath())
    })

    this.app.get('/admin', (_req: any, res: any) => {
      res.type('text/html').send(renderAdminPage())
    })

    if ((this.context.authWallet == null) || this.context.config.adminIdentityKeys.length === 0) {
      this.app.use((_req: any, res: any) => {
        res
          .status(503)
          .type('text/plain')
          .send('Admin server requires ADMIN_IDENTITY_KEYS and a running monitor runtime.')
      })
      return
    }

    this.app.use(
      createAuthMiddleware({
        wallet: this.context.authWallet
      })
    )
    this.app.use('/admin/api', this.requireAdmin.bind(this))

    this.app.get('/admin/api/stats', async (req: any, res: any) => {
      const storage = await getStorage(this.context)
      const stats = await storage.adminStats(req.auth.identityKey)
      const formattedStats = {
        satoshisDefaultDayFormatted: formatSatoshis(stats.satoshisDefaultDay),
        satoshisDefaultWeekFormatted: formatSatoshis(stats.satoshisDefaultWeek),
        satoshisDefaultMonthFormatted: formatSatoshis(stats.satoshisDefaultMonth),
        satoshisDefaultTotalFormatted: formatSatoshis(stats.satoshisDefaultTotal),
        satoshisOtherDayFormatted: formatSatoshis(stats.satoshisOtherDay),
        satoshisOtherWeekFormatted: formatSatoshis(stats.satoshisOtherWeek),
        satoshisOtherMonthFormatted: formatSatoshis(stats.satoshisOtherMonth),
        satoshisOtherTotalFormatted: formatSatoshis(stats.satoshisOtherTotal)
      }
      const reqsTotal = await storage.countProvenTxReqs({ partial: {} })
      const mergedStats = { ...stats, ...formattedStats, reqsTotal }
      res.json({
        requestedBy: req.auth.identityKey,
        stats: mergedStats,
        statsLog: toAdminStatsLog(stats)
      })
    })

    this.app.get('/admin/api/events', async (req: any, res: any) => {
      const storage = await getStorage(this.context)
      const limit = Math.min(asNumber(req.query.limit, 20), 200)
      const offset = Math.max(asNumber(req.query.offset, 0), 0)
      const event = typeof req.query.event === 'string' && req.query.event.trim() ? req.query.event.trim() : undefined
      const partial = event ? { event } : {}
      const [events, total] = await Promise.all([
        storage.findMonitorEvents({ partial, orderDescending: true, paged: { limit, offset } }),
        storage.countMonitorEvents({ partial })
      ])
      res.json({
        total,
        events: events.map(item => ({
          ...item,
          detailsJson: parseJson(item.details),
          detailsPretty: prettyJson(item.details)
        }))
      })
    })

    this.app.get('/admin/api/tasks', async (_req: any, res: any) => {
      const monitor = this.context.daemon.setup?.monitor
      if (monitor == null) throw new Error('Monitor is not available.')
      res.json({
        tasks: [
          ...monitor._tasks.map(task => ({ name: task.name, kind: 'scheduled' })),
          ...monitor._otherTasks.map(task => ({ name: task.name, kind: 'manual' }))
        ]
      })
    })

    this.app.get('/admin/api/users', async (req: any, res: any) => {
      res.json(await queryUsers(this.context, req.query || {}))
    })

    this.app.get('/admin/api/call-history', async (req: any, res: any) => {
      res.json(await queryMonitorCallHistory(this.context, req.query || {}))
    })

    this.app.post('/admin/api/tasks/:name/run', async (req: any, res: any) => {
      const monitor = this.context.daemon.setup?.monitor
      const storage = await getStorage(this.context)
      if (monitor == null) throw new Error('Monitor is not available.')
      const name = String(req.params.name)
      const log = await monitor.runTask(name)
      await storage.insertMonitorEvent({
        created_at: new Date(),
        updated_at: new Date(),
        id: 0,
        event: 'AdminTaskRun',
        details: JSON.stringify({ requestedBy: req.auth.identityKey, taskName: name, log })
      })
      res.json({ task: name, log })
    })

    this.app.post('/admin/api/review-utxos', async (req: any, res: any) => {
      const userInput = typeof req.body?.identityKey === 'string' ? req.body.identityKey.trim() : ''
      if (!userInput) throw new Error('identityKey or userId is required.')
      const mode = normalizeReviewMode(req.body?.mode)
      res.json(await reviewUtxosByIdentityKey(this.context, req.auth.identityKey, userInput, mode))
    })

    this.app.get('/admin/api/proven-tx-reqs/review', async (req: any, res: any) => {
      res.json(await queryReqReview(this.context, req.query || {}))
    })

    this.app.get('/admin/api/proven-tx-reqs/:id', async (req: any, res: any) => {
      res.json(await getReqDetail(this.context, asNumber(req.params.id, -1)))
    })

    this.app.get('/admin/api/proven-tx-reqs/:id/decode', async (req: any, res: any) => {
      const detail = await getReqDetail(this.context, asNumber(req.params.id, -1))
      res.json({
        provenTxReqId: detail.req.provenTxReqId,
        txid: detail.req.txid,
        rawTxHex: detail.rawTxHex,
        decodedRawTx: detail.decodedRawTx
      })
    })

    this.app.post('/admin/api/proven-tx-reqs/:id/rebroadcast', async (req: any, res: any) => {
      const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'taal'
      res.json(await rebroadcastReq(this.context, asNumber(req.params.id, -1), provider, req.auth.identityKey))
    })

    this.app.use((error: any, _req: any, res: any, _next: any) => {
      const e = sdk.WalletError.fromUnknown(error)
      res.status(500).json({ error: { code: e.code, message: e.message, description: e.description } })
    })
  }

  private requireAdmin (req: any, _res: any, next: any): void {
    const identityKey = req.auth?.identityKey
    if (!identityKey || !this.context.config.adminIdentityKeys.includes(identityKey)) {
      next(new Error('Authenticated user is not an allowed monitor admin.'))
      return
    }
    next()
  }

  start (): void {
    this.server = this.app.listen(this.context.config.adminPort, this.context.config.adminHost, () => {
      console.log(
        `Monitor admin listening at http://${this.context.config.adminHost}:${this.context.config.adminPort}/admin`
      )
    })
  }

  async close (): Promise<void> {
    if (!this.server) return
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    this.server = undefined
  }
}
