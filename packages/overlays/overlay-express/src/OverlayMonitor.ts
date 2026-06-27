import { Beef, Transaction } from '@bsv/sdk'

export interface OverlayMonitorLogger {
  log: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
}

export interface OverlayLookupProbe {
  name?: string
  service: string
  query: unknown
  maxOutputs?: number
}

export interface OverlayAnchorProbe {
  name?: string
  topic: string
  expectedTac?: string
  expectedBlockHeight?: number
  currentHeight?: number
  maxTipLagBlocks?: number
}

export interface OverlayMaintenanceConfig {
  adminToken?: string
  headers?: Record<string, string>
  maintainUnproven?: boolean | {
    topics?: string[]
    thresholdBlocks?: number
  }
  startBASMSync?: boolean
  janitor?: boolean
}

export interface OverlayMonitorTarget {
  name: string
  baseUrl: string
  probes: OverlayLookupProbe[]
  anchorProbes?: OverlayAnchorProbe[]
  maintenance?: OverlayMaintenanceConfig
  headers?: Record<string, string>
}

export interface OverlayMonitorThresholds {
  responseBytes?: number
  beefBytes?: number
  txsWithoutProof?: number
  requireSubjectProof?: boolean
  anchorTipLagBlocks?: number
  expiredUnprovenCount?: number
}

export interface OverlayMonitorConfig {
  targets: OverlayMonitorTarget[]
  thresholds?: OverlayMonitorThresholds
  intervalMs?: number
  /** Per-probe request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  logger?: OverlayMonitorLogger
  onReport?: (report: OverlayMonitorReport) => Promise<void> | void
  now?: () => Date
}

export interface OverlayMonitorWarning {
  code: 'response-bytes' | 'beef-bytes' | 'txs-without-proof' | 'subject-proof-missing' | 'anchor-tip-mismatch' | 'anchor-stale-height' | 'expired-unproven-state'
  message: string
  value: number | boolean
  threshold?: number | boolean
  outputIndex?: number
  txid?: string
}

export interface OverlayLookupOutputSummary {
  outputIndex: number
  txid?: string
  beefBytes: number
  txCount?: number
  proofCount?: number
  txsWithoutProof?: number
  subjectHasProof?: boolean
  subjectRawTxBytes?: number
  currentToSubjectRawRatio?: number
  contextBytes?: number
  error?: string
}

export interface OverlayLookupProbeResult {
  target: string
  url: string
  probe: string
  service: string
  status: number
  ok: boolean
  responseBytes: number
  outputCount: number
  analyzedOutputCount: number
  outputs: OverlayLookupOutputSummary[]
  warnings: OverlayMonitorWarning[]
  durationMs: number
  error?: string
}

export interface OverlayAnchorProbeResult {
  target: string
  url: string
  probe: string
  topic: string
  status: number
  ok: boolean
  responseBytes: number
  blockHeight?: number
  tac?: string
  warnings: OverlayMonitorWarning[]
  durationMs: number
  error?: string
}

export interface OverlayMaintenanceResult {
  target: string
  url: string
  operation: 'maintain-unproven' | 'start-basm-sync' | 'janitor'
  topic?: string
  status: number
  ok: boolean
  responseBytes: number
  durationMs: number
  data?: unknown
  error?: string
}

export interface OverlayMonitorReport {
  startedAt: Date
  completedAt: Date
  durationMs: number
  results: OverlayLookupProbeResult[]
  anchorResults: OverlayAnchorProbeResult[]
  maintenanceResults: OverlayMaintenanceResult[]
  summary: {
    targetCount: number
    probeCount: number
    anchorProbeCount: number
    maintenanceActionCount: number
    failedProbeCount: number
    failedMaintenanceActionCount: number
    responseBytes: number
    outputCount: number
    analyzedOutputCount: number
    outputsMissingSubjectProof: number
    warningCount: number
  }
}

interface AnalyzeOptions {
  target: string
  url: string
  probe: string
  service: string
  status: number
  ok: boolean
  responseBody: unknown
  responseBytes: number
  durationMs: number
  thresholds?: OverlayMonitorThresholds
  maxOutputs?: number
  error?: string
}

const defaultThresholds: Required<OverlayMonitorThresholds> = {
  responseBytes: 1024 * 1024,
  beefBytes: 64 * 1024,
  txsWithoutProof: 1,
  requireSubjectProof: true,
  anchorTipLagBlocks: 6,
  expiredUnprovenCount: 0
}

/**
 * OverlayMonitor runs generic Overlay Express /lookup probes and reports response
 * size plus BEEF proof shape. It is intended for long-running monitor workers or
 * scheduled jobs, analogous to a storage monitor but scoped to overlay health.
 */
export class OverlayMonitor {
  private readonly targets: OverlayMonitorTarget[]
  private readonly thresholds: Required<OverlayMonitorThresholds>
  private readonly fetchImpl: typeof fetch
  private readonly logger: OverlayMonitorLogger
  private readonly onReport?: (report: OverlayMonitorReport) => Promise<void> | void
  private readonly now: () => Date
  private readonly intervalMs?: number
  private readonly timeoutMs: number
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor (config: OverlayMonitorConfig) {
    this.targets = config.targets
    this.thresholds = { ...defaultThresholds, ...config.thresholds }
    // Bind to globalThis so calling through this.fetchImpl does not rebind `this`
    // (browser fetch throws "Illegal invocation" when invoked as a method).
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis)
    this.logger = config.logger ?? console
    this.onReport = config.onReport
    this.now = config.now ?? (() => new Date())
    this.intervalMs = config.intervalMs
    this.timeoutMs = config.timeoutMs ?? 30000
  }

  async runOnce (): Promise<OverlayMonitorReport> {
    const startedAt = this.now()
    const results: OverlayLookupProbeResult[] = []
    const anchorResults: OverlayAnchorProbeResult[] = []
    const maintenanceResults: OverlayMaintenanceResult[] = []

    for (const target of this.targets) {
      for (const probe of target.probes) {
        results.push(await this.runProbe(target, probe))
      }
      for (const probe of target.anchorProbes ?? []) {
        anchorResults.push(await this.runAnchorProbe(target, probe))
      }
      maintenanceResults.push(...await this.runMaintenance(target))
    }

    const completedAt = this.now()
    const report: OverlayMonitorReport = {
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      results,
      anchorResults,
      maintenanceResults,
      summary: summarize(results, anchorResults, maintenanceResults, this.targets.length)
    }

    await this.onReport?.(report)
    return report
  }

  start (): void {
    if (this.intervalMs === undefined) {
      throw new Error('intervalMs is required to start OverlayMonitor')
    }
    if (this.timer !== undefined) return

    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      this.runOnce()
        .catch(error => {
          this.logger.error('OverlayMonitor run failed', error)
        })
        .finally(() => {
          this.running = false
        })
    }, this.intervalMs)
  }

  stop (): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async runProbe (target: OverlayMonitorTarget, probe: OverlayLookupProbe): Promise<OverlayLookupProbeResult> {
    const startedAt = this.now()
    const url = new URL('/lookup', target.baseUrl).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...target.headers
        },
        body: JSON.stringify({ service: probe.service, query: probe.query }),
        signal: controller.signal
      })
      const text = await response.text()
      const responseBytes = new TextEncoder().encode(text).length
      const completedAt = this.now()

      let body: unknown
      try {
        body = text.length === 0 ? {} : JSON.parse(text)
      } catch (error) {
        return makeFailedResult({
          target,
          probe,
          url,
          status: response.status,
          ok: response.ok,
          responseBytes,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          error: error instanceof Error ? error.message : 'Invalid JSON response'
        })
      }

      return analyzeOverlayLookupResponse({
        target: target.name,
        url,
        probe: probe.name ?? probe.service,
        service: probe.service,
        status: response.status,
        ok: response.ok,
        responseBody: body,
        responseBytes,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        thresholds: this.thresholds,
        maxOutputs: probe.maxOutputs
      })
    } catch (error) {
      const completedAt = this.now()
      const fallbackMessage = error instanceof Error ? error.message : 'Lookup probe failed'
      const message = controller.signal.aborted
        ? `Lookup probe timed out after ${this.timeoutMs}ms`
        : fallbackMessage
      return makeFailedResult({
        target,
        probe,
        url,
        status: 0,
        ok: false,
        responseBytes: 0,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        error: message
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async runAnchorProbe(target: OverlayMonitorTarget, probe: OverlayAnchorProbe): Promise<OverlayAnchorProbeResult> {
    const startedAt = this.now()
    const url = new URL('/requestTopicAnchorTip', target.baseUrl).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-bsv-topic': probe.topic,
          ...target.headers
        },
        body: JSON.stringify({}),
        signal: controller.signal
      })
      const text = await response.text()
      const responseBytes = new TextEncoder().encode(text).length
      const completedAt = this.now()
      let body: Record<string, unknown>

      try {
        body = text.length === 0 ? {} : JSON.parse(text)
      } catch (error) {
        return makeFailedAnchorResult({
          target,
          probe,
          url,
          status: response.status,
          ok: response.ok,
          responseBytes,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          error: error instanceof Error ? error.message : 'Invalid JSON response'
        })
      }

      return analyzeOverlayAnchorTip({
        target: target.name,
        url,
        probe: probe.name ?? probe.topic,
        topic: probe.topic,
        status: response.status,
        ok: response.ok,
        responseBody: body,
        responseBytes,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        thresholds: this.thresholds,
        expectedTac: probe.expectedTac,
        expectedBlockHeight: probe.expectedBlockHeight,
        currentHeight: probe.currentHeight,
        maxTipLagBlocks: probe.maxTipLagBlocks
      })
    } catch (error) {
      const completedAt = this.now()
      const fallbackMessage = error instanceof Error ? error.message : 'Anchor probe failed'
      const message = controller.signal.aborted
        ? `Anchor probe timed out after ${this.timeoutMs}ms`
        : fallbackMessage
      return makeFailedAnchorResult({
        target,
        probe,
        url,
        status: 0,
        ok: false,
        responseBytes: 0,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        error: message
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async runMaintenance(target: OverlayMonitorTarget): Promise<OverlayMaintenanceResult[]> {
    const maintenance = target.maintenance
    if (maintenance === undefined) return []

    const results: OverlayMaintenanceResult[] = []
    if (maintenance.startBASMSync === true) {
      results.push(await this.runMaintenanceRequest(target, maintenance, 'start-basm-sync', '/admin/startBASMSync', {}))
    }
    if (maintenance.maintainUnproven !== undefined && maintenance.maintainUnproven !== false) {
      const config = maintenance.maintainUnproven === true ? {} : maintenance.maintainUnproven
      const topics = config.topics !== undefined && config.topics.length > 0 ? config.topics : [undefined]
      for (const topic of topics) {
        results.push(await this.runMaintenanceRequest(
          target,
          maintenance,
          'maintain-unproven',
          '/admin/maintainUnproven',
          {
            topic,
            thresholdBlocks: config.thresholdBlocks
          }
        ))
      }
    }
    if (maintenance.janitor === true) {
      results.push(await this.runMaintenanceRequest(target, maintenance, 'janitor', '/admin/janitor', {}))
    }
    return results
  }

  private async runMaintenanceRequest(
    target: OverlayMonitorTarget,
    maintenance: OverlayMaintenanceConfig,
    operation: OverlayMaintenanceResult['operation'],
    path: string,
    body: { topic?: string, thresholdBlocks?: number }
  ): Promise<OverlayMaintenanceResult> {
    const startedAt = this.now()
    const url = new URL(path, target.baseUrl).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...target.headers,
        ...maintenance.headers
      }
      if (maintenance.adminToken !== undefined && maintenance.adminToken !== '') {
        headers.Authorization = `Bearer ${maintenance.adminToken}`
      }
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(stripUndefined(body)),
        signal: controller.signal
      })
      const text = await response.text()
      const responseBytes = new TextEncoder().encode(text).length
      const completedAt = this.now()
      let parsed: unknown
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text)
      } catch (error) {
        return {
          target: target.name,
          url,
          operation,
          topic: body.topic,
          status: response.status,
          ok: false,
          responseBytes,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          error: error instanceof Error ? error.message : 'Invalid JSON response'
        }
      }
      return {
        target: target.name,
        url,
        operation,
        topic: body.topic,
        status: response.status,
        ok: response.ok,
        responseBytes,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        data: parsed,
        error: response.ok ? undefined : readErrorMessage(parsed)
      }
    } catch (error) {
      const completedAt = this.now()
      const fallbackMessage = error instanceof Error ? error.message : 'Maintenance request failed'
      const message = controller.signal.aborted
        ? `Maintenance request timed out after ${this.timeoutMs}ms`
        : fallbackMessage
      return {
        target: target.name,
        url,
        operation,
        topic: body.topic,
        status: 0,
        ok: false,
        responseBytes: 0,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        error: message
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function analyzeOverlayAnchorTip(options: {
  target: string
  url: string
  probe: string
  topic: string
  status: number
  ok: boolean
  responseBody: Record<string, unknown>
  responseBytes: number
  durationMs: number
  thresholds?: OverlayMonitorThresholds
  expectedTac?: string
  expectedBlockHeight?: number
  currentHeight?: number
  maxTipLagBlocks?: number
}): OverlayAnchorProbeResult {
  const thresholds = { ...defaultThresholds, ...options.thresholds }
  const blockHeight = typeof options.responseBody.blockHeight === 'number' ? options.responseBody.blockHeight : undefined
  const tac = typeof options.responseBody.tac === 'string' ? options.responseBody.tac : undefined
  let expiredUnprovenCount: number | undefined
  if (typeof options.responseBody.expiredUnprovenCount === 'number') {
    expiredUnprovenCount = options.responseBody.expiredUnprovenCount
  } else if (typeof options.responseBody.unprovenExpiredCount === 'number') {
    expiredUnprovenCount = options.responseBody.unprovenExpiredCount
  } else {
    expiredUnprovenCount = undefined
  }
  const warnings: OverlayMonitorWarning[] = []

  if (options.expectedTac !== undefined && tac !== undefined && tac !== options.expectedTac) {
    warnings.push({
      code: 'anchor-tip-mismatch',
      message: 'Topic anchor TAC does not match expected value',
      value: true,
      threshold: false
    })
  }

  const expectedHeight = options.expectedBlockHeight ?? options.currentHeight
  const maxLag = options.maxTipLagBlocks ?? thresholds.anchorTipLagBlocks
  if (expectedHeight !== undefined && blockHeight !== undefined && expectedHeight - blockHeight > maxLag) {
    warnings.push({
      code: 'anchor-stale-height',
      message: `Topic anchor tip is ${expectedHeight - blockHeight} blocks behind`,
      value: expectedHeight - blockHeight,
      threshold: maxLag
    })
  }

  if (expiredUnprovenCount !== undefined && expiredUnprovenCount > thresholds.expiredUnprovenCount) {
    warnings.push({
      code: 'expired-unproven-state',
      message: `Overlay reports ${expiredUnprovenCount} expired unproven transactions`,
      value: expiredUnprovenCount,
      threshold: thresholds.expiredUnprovenCount
    })
  }

  return {
    target: options.target,
    url: options.url,
    probe: options.probe,
    topic: options.topic,
    status: options.status,
    ok: options.ok,
    responseBytes: options.responseBytes,
    blockHeight,
    tac,
    warnings,
    durationMs: options.durationMs
  }
}

export function analyzeOverlayLookupResponse (options: AnalyzeOptions): OverlayLookupProbeResult {
  const thresholds = { ...defaultThresholds, ...options.thresholds }
  const outputs = extractOutputs(options.responseBody)
  const maxOutputs = options.maxOutputs ?? outputs.length
  const analyzedOutputs = outputs.slice(0, maxOutputs).map(analyzeOutput)
  const warnings: OverlayMonitorWarning[] = []

  if (options.responseBytes >= thresholds.responseBytes) {
    warnings.push({
      code: 'response-bytes',
      message: `Lookup response is ${options.responseBytes} bytes`,
      value: options.responseBytes,
      threshold: thresholds.responseBytes
    })
  }

  for (const output of analyzedOutputs) {
    addOutputWarnings(warnings, output, thresholds)
  }

  return {
    target: options.target,
    url: options.url,
    probe: options.probe,
    service: options.service,
    status: options.status,
    ok: options.ok,
    responseBytes: options.responseBytes,
    outputCount: outputs.length,
    analyzedOutputCount: analyzedOutputs.length,
    outputs: analyzedOutputs,
    warnings,
    durationMs: options.durationMs,
    error: options.error
  }
}

function makeFailedResult (options: {
  target: OverlayMonitorTarget
  probe: OverlayLookupProbe
  url: string
  status: number
  ok: boolean
  responseBytes: number
  durationMs: number
  error: string
}): OverlayLookupProbeResult {
  return {
    target: options.target.name,
    url: options.url,
    probe: options.probe.name ?? options.probe.service,
    service: options.probe.service,
    status: options.status,
    ok: options.ok,
    responseBytes: options.responseBytes,
    outputCount: 0,
    analyzedOutputCount: 0,
    outputs: [],
    warnings: [],
    durationMs: options.durationMs,
    error: options.error
  }
}

function makeFailedAnchorResult(options: {
  target: OverlayMonitorTarget
  probe: OverlayAnchorProbe
  url: string
  status: number
  ok: boolean
  responseBytes: number
  durationMs: number
  error: string
}): OverlayAnchorProbeResult {
  return {
    target: options.target.name,
    url: options.url,
    probe: options.probe.name ?? options.probe.topic,
    topic: options.probe.topic,
    status: options.status,
    ok: options.ok,
    responseBytes: options.responseBytes,
    warnings: [],
    durationMs: options.durationMs,
    error: options.error
  }
}

function summarize (
  results: OverlayLookupProbeResult[],
  anchorResults: OverlayAnchorProbeResult[],
  maintenanceResults: OverlayMaintenanceResult[],
  targetCount: number
): OverlayMonitorReport['summary'] {
  return {
    targetCount,
    probeCount: results.length,
    anchorProbeCount: anchorResults.length,
    maintenanceActionCount: maintenanceResults.length,
    failedProbeCount: results.filter(result => !result.ok || result.error !== undefined).length +
      anchorResults.filter(result => !result.ok || result.error !== undefined).length,
    failedMaintenanceActionCount: maintenanceResults.filter(result => !result.ok || result.error !== undefined).length,
    responseBytes: results.reduce((sum, result) => sum + result.responseBytes, 0) +
      anchorResults.reduce((sum, result) => sum + result.responseBytes, 0) +
      maintenanceResults.reduce((sum, result) => sum + result.responseBytes, 0),
    outputCount: results.reduce((sum, result) => sum + result.outputCount, 0),
    analyzedOutputCount: results.reduce((sum, result) => sum + result.analyzedOutputCount, 0),
    outputsMissingSubjectProof: results.reduce((sum, result) => {
      return sum + result.outputs.filter(output => output.subjectHasProof === false).length
    }, 0),
    warningCount: results.reduce((sum, result) => sum + result.warnings.length, 0) +
      anchorResults.reduce((sum, result) => sum + result.warnings.length, 0)
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function readErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

function extractOutputs (body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || !('outputs' in body)) return []
  const outputs = (body as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return []
  return outputs.filter((output): output is Record<string, unknown> => typeof output === 'object' && output !== null)
}

function analyzeOutput (output: Record<string, unknown>): OverlayLookupOutputSummary {
  const outputIndex = typeof output.outputIndex === 'number' ? output.outputIndex : -1
  const beef = readNumberArray(output.beef)
  const context = readNumberArray(output.context)

  if (beef === undefined) {
    return {
      outputIndex,
      beefBytes: 0,
      contextBytes: context?.length,
      error: 'Output did not include numeric BEEF'
    }
  }

  try {
    const subjectTx = Transaction.fromBEEF(beef)
    const txid = subjectTx.id('hex')
    const parsedBeef = Beef.fromBinary(beef)
    const subject = parsedBeef.findTxid(txid)
    const subjectRawTxBytes = subject?.rawTx?.length ?? subjectTx.toBinary().length
    const proofCount = parsedBeef.txs.filter(tx => tx.hasProof).length
    const txsWithoutProof = parsedBeef.txs.filter(tx => !tx.hasProof && !tx.isTxidOnly).length

    return {
      outputIndex,
      txid,
      beefBytes: beef.length,
      txCount: parsedBeef.txs.length,
      proofCount,
      txsWithoutProof,
      subjectHasProof: subject?.hasProof ?? false,
      subjectRawTxBytes,
      currentToSubjectRawRatio: subjectRawTxBytes > 0 ? beef.length / subjectRawTxBytes : undefined,
      contextBytes: context?.length
    }
  } catch (error) {
    return {
      outputIndex,
      beefBytes: beef.length,
      contextBytes: context?.length,
      error: error instanceof Error ? error.message : 'Failed to parse BEEF'
    }
  }
}

function addOutputWarnings (
  warnings: OverlayMonitorWarning[],
  output: OverlayLookupOutputSummary,
  thresholds: Required<OverlayMonitorThresholds>
): void {
  if (output.beefBytes >= thresholds.beefBytes) {
    warnings.push({
      code: 'beef-bytes',
      message: `Output BEEF is ${output.beefBytes} bytes`,
      value: output.beefBytes,
      threshold: thresholds.beefBytes,
      outputIndex: output.outputIndex,
      txid: output.txid
    })
  }

  if (typeof output.txsWithoutProof === 'number' && output.txsWithoutProof >= thresholds.txsWithoutProof) {
    warnings.push({
      code: 'txs-without-proof',
      message: `Output BEEF has ${output.txsWithoutProof} transactions without direct proof`,
      value: output.txsWithoutProof,
      threshold: thresholds.txsWithoutProof,
      outputIndex: output.outputIndex,
      txid: output.txid
    })
  }

  if (thresholds.requireSubjectProof && output.subjectHasProof === false) {
    warnings.push({
      code: 'subject-proof-missing',
      message: 'Output subject transaction does not have a direct Merkle proof',
      value: false,
      threshold: true,
      outputIndex: output.outputIndex,
      txid: output.txid
    })
  }
}

function readNumberArray (value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) return undefined
  return value
}
