import {
  Transaction as BsvTransaction,
  Beef,
  ChainTracker,
  Telemetry,
  TelemetrySpan,
  WalletLoggerInterface
} from '@bsv/sdk'
import { Writer, toArray, toHex } from '@bsv/sdk/primitives/utils'
import { ServiceCollection, ServiceToCall } from './ServiceCollection'
import { createDefaultWalletServicesOptions } from './createDefaultWalletServicesOptions'
import { WhatsOnChain } from './providers/WhatsOnChain'
import { updateChaintracksFiatExchangeRates, updateExchangeratesapi } from './providers/exchangeRates'
import { ARC } from './providers/ARC'
import { Arcade } from './providers/Arcade'
import { Bitails } from './providers/Bitails'
import { getBeefForTxid } from './providers/getBeefForTxid'
import {
  BaseBlockHeader,
  BlockHeader,
  FiatExchangeRates,
  GetMerklePathResult,
  GetMerklePathService,
  GetRawTxResult,
  GetRawTxService,
  GetScriptHashHistoryResult,
  GetScriptHashHistoryService,
  GetStatusForTxidsResult,
  GetStatusForTxidsService,
  GetUtxoStatusOutputFormat,
  GetUtxoStatusResult,
  GetUtxoStatusService,
  PostBeefResult,
  PostBeefService,
  ServicesCallHistory,
  UpdateFiatExchangeRateService,
  WalletServices,
  WalletServicesOptions
} from '../sdk/WalletServices.interfaces'
import type { FiatCurrencyCode } from '../sdk/WalletServices.interfaces'
import { Chain } from '../sdk/types'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { ChaintracksChainTracker } from './chaintracker/ChaintracksChainTracker'
import { WalletError } from '../sdk/WalletError'
import { doubleSha256BE, sha256Hash, wait } from '../utility/utilityHelpers'
import { TableOutput } from '../storage/schema/tables/TableOutput'
import { asArray, asString } from '../utility/utilityHelpers.noBuffer'
import { classifyOutputUtxo, requireConclusiveUtxo } from './classifyOutputUtxo'
import {
  copyValidatedBlockHeader,
  normalizeTxid,
  snapshotMerklePathResult,
  validateMerklePathResult,
  ValidatedMerklePathResult
} from './validateMerklePathResult'
import { validateStatusForTxidsResult } from './validateStatusForTxidsResult'
import { MAX_RAW_TRANSACTION_BYTES, validateRawTxResult } from './validateRawTxResult'
import { normalizeWalletOutpoint, validateUtxoStatusResult } from './validateUtxoStatusResult'
import { validateScriptHashHistoryResult } from './validateScriptHashHistoryResult'
import { makePostBeefServiceError, snapshotPostBeefRequest, validatePostBeefResult } from './validatePostBeefResult'
import {
  isValidFiatRate,
  normalizeFiatCurrencies,
  normalizeFiatCurrency,
  normalizeFiatExchangeRates,
  normalizeFiatRateTimestamps
} from './fiatRateValidation'
import { validateCanonicalMerklePathResult } from './getCanonicalMerklePath'

function copyFiatExchangeRates(rates: FiatExchangeRates): FiatExchangeRates {
  return {
    timestamp: new Date(rates.timestamp.getTime()),
    base: rates.base,
    rates: { ...rates.rates },
    rateTimestamps:
      rates.rateTimestamps == null
        ? undefined
        : Object.fromEntries(
            Object.entries(rates.rateTimestamps).map(([key, value]) => [key, new Date(value.getTime())])
          )
  }
}

export class Services implements WalletServices {
  private identityChainTracker?: ChaintracksChainTracker
  private identityChainTrackerInit?: Promise<ChaintracksChainTracker>
  static readonly getStatusForTxidsBatchLimit = 20

  static createDefaultOptions(chain: Chain): WalletServicesOptions {
    return createDefaultWalletServicesOptions(chain)
  }

  options: WalletServicesOptions
  whatsonchain: WhatsOnChain
  arcTaal: ARC
  arcGorillaPool?: ARC
  /** Primary Arcade (bsv-blockchain/arcade) broadcaster, when `options.arcadeUrl` is set. */
  arcade?: Arcade
  bitails?: Bitails

  getMerklePathServices!: ServiceCollection<GetMerklePathService>
  getRawTxServices!: ServiceCollection<GetRawTxService>
  postBeefServices!: ServiceCollection<PostBeefService>
  getUtxoStatusServices!: ServiceCollection<GetUtxoStatusService>
  getStatusForTxidsServices!: ServiceCollection<GetStatusForTxidsService>
  getScriptHashHistoryServices!: ServiceCollection<GetScriptHashHistoryService>
  updateFiatExchangeRateServices!: ServiceCollection<UpdateFiatExchangeRateService>

  chain: Chain
  readonly telemetry: Telemetry

  constructor(optionsOrChain: Chain | WalletServicesOptions) {
    this.chain = typeof optionsOrChain === 'string' ? optionsOrChain : optionsOrChain.chain

    if (this.chain === 'mock') {
      throw new WERR_INVALID_PARAMETER(
        'chain',
        "'main', 'test', 'stn', 'ttn', 'tstn', or 'regtest'. Use MockServices for 'mock' chain."
      )
    }

    this.options = typeof optionsOrChain === 'string' ? Services.createDefaultOptions(this.chain) : optionsOrChain
    this.telemetry = new Telemetry(this.options.telemetry)

    this.whatsonchain = new WhatsOnChain(this.chain, { apiKey: this.options.whatsOnChainApiKey }, this)

    this.arcTaal = new ARC(this.options.arcUrl, this.options.arcConfig, 'arcTaal')
    const { hasBitails, hasWhatsOnChain } = this.configureOptionalProviders()
    this.initializeReadServices(hasBitails, hasWhatsOnChain)
    this.initializePostBeefServices(hasBitails, hasWhatsOnChain)
    this.initializeFiatRateServices()
  }

  private configureOptionalProviders(): { hasBitails: boolean; hasWhatsOnChain: boolean } {
    if (this.options.arcGorillaPoolUrl != null && this.options.arcGorillaPoolUrl !== '') {
      this.arcGorillaPool = new ARC(this.options.arcGorillaPoolUrl, this.options.arcGorillaPoolConfig, 'arcGorillaPool')
    }
    if (this.options.arcadeUrl != null && this.options.arcadeUrl !== '') {
      this.arcade = new Arcade(this.options.arcadeUrl, this.options.arcadeConfig, 'arcade')
    }

    const hasBitails = this.chain === 'main' || this.chain === 'test'

    // The public WhatsOnChain API documents mainnet and testnet only.
    // Teranode-family networks use Arcade/ChainTracks and explicit operator
    // endpoints instead of being silently aliased to testnet.
    const hasWhatsOnChain = this.chain === 'main' || this.chain === 'test'

    if (hasBitails) {
      this.bitails = new Bitails(this.chain, { apiKey: this.options.bitailsApiKey })
    }
    return { hasBitails, hasWhatsOnChain }
  }

  private initializeReadServices(hasBitails: boolean, hasWhatsOnChain: boolean): void {
    this.getMerklePathServices = new ServiceCollection<GetMerklePathService>('getMerklePath')
    // Arcade is first when configured: it can return proofs for transactions
    // it broadcast and otherwise allows the collection to fall through.
    if (this.arcade != null) {
      // prettier-ignore
      this.getMerklePathServices.add({ name: 'Arcade', service: this.arcade.getMerklePath.bind(this.arcade) })
    }
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.getMerklePathServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.getMerklePath.bind(this.whatsonchain) })
    }
    if (hasBitails && this.bitails != null) {
      this.getMerklePathServices.add({ name: 'Bitails', service: this.bitails.getMerklePath.bind(this.bitails) })
    }

    this.getRawTxServices = new ServiceCollection<GetRawTxService>('getRawTx')
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.getRawTxServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.getRawTxResult.bind(this.whatsonchain) })
    }

    this.getUtxoStatusServices = new ServiceCollection<GetUtxoStatusService>('getUtxoStatus')
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.getUtxoStatusServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.getUtxoStatus.bind(this.whatsonchain) })
    }

    this.getStatusForTxidsServices = new ServiceCollection<GetStatusForTxidsService>('getStatusForTxids')
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.getStatusForTxidsServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.getStatusForTxids.bind(this.whatsonchain) })
    }
    if (this.arcade != null) {
      // Arcade's lifecycle store keeps status reconciliation available when
      // the explorer is disabled or unavailable. Keep the existing explorer
      // first when configured because a successful `unknown` is a valid,
      // conservative answer and the shared collection does not merge partial
      // results from multiple providers.
      this.getStatusForTxidsServices.add({
        name: 'Arcade',
        service: this.arcade.getStatusForTxids.bind(this.arcade)
      })
    }

    this.getScriptHashHistoryServices = new ServiceCollection<GetScriptHashHistoryService>('getScriptHashHistory')
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.getScriptHashHistoryServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.getScriptHashHistory.bind(this.whatsonchain) })
    }
  }

  private initializePostBeefServices(hasBitails: boolean, hasWhatsOnChain: boolean): void {
    this.postBeefServices = new ServiceCollection<PostBeefService>('postBeef')
    // Arcade remains the primary broadcaster. ARC and explorer providers
    // retain their existing fallback order under the default UntilSuccess mode.
    if (this.arcade != null) {
      // prettier-ignore
      this.postBeefServices.add({ name: 'ArcadeBeef', service: this.arcade.postBeef.bind(this.arcade) })
    }
    if (this.arcGorillaPool != null) {
      // prettier-ignore
      this.postBeefServices.add({ name: 'GorillaPoolArcBeef', service: this.arcGorillaPool.postBeef.bind(this.arcGorillaPool) })
    }
    if (this.options.arcUrl != null && this.options.arcUrl !== '') {
      // prettier-ignore
      this.postBeefServices
        .add({ name: 'TaalArcBeef', service: this.arcTaal.postBeef.bind(this.arcTaal) })
    }
    if (hasBitails && this.bitails != null) {
      this.postBeefServices.add({ name: 'Bitails', service: this.bitails.postBeef.bind(this.bitails) })
    }
    if (hasWhatsOnChain) {
      // prettier-ignore
      this.postBeefServices
        .add({ name: 'WhatsOnChain', service: this.whatsonchain.postBeef.bind(this.whatsonchain) })
    }
  }

  private initializeFiatRateServices(): void {
    // prettier-ignore
    this.updateFiatExchangeRateServices = new ServiceCollection<UpdateFiatExchangeRateService>('updateFiatExchangeRate')
    // A configured paid exchange-rate service is exclusive; otherwise use
    // Chaintracks as the zero-configuration default.
    if (this.options.exchangeratesapiKey != null && this.options.exchangeratesapiKey !== '') {
      this.updateFiatExchangeRateServices.add({ name: 'exchangeratesapi', service: updateExchangeratesapi })
    } else {
      this.updateFiatExchangeRateServices.add({
        name: 'ChaintracksFiatRates',
        service: updateChaintracksFiatExchangeRates
      })
    }
  }

  getServicesCallHistory(reset?: boolean): ServicesCallHistory {
    return {
      version: 2,
      getMerklePath: this.getMerklePathServices.getServiceCallHistory(reset),
      getRawTx: this.getRawTxServices.getServiceCallHistory(reset),
      postBeef: this.postBeefServices.getServiceCallHistory(reset),
      getUtxoStatus: this.getUtxoStatusServices.getServiceCallHistory(reset),
      getStatusForTxids: this.getStatusForTxidsServices.getServiceCallHistory(reset),
      getScriptHashHistory: this.getScriptHashHistoryServices.getServiceCallHistory(reset),
      updateFiatExchangeRates: this.updateFiatExchangeRateServices.getServiceCallHistory(reset)
    }
  }

  async getChainTracker(): Promise<ChainTracker> {
    while (true) {
      if (this.options.chainTracker != null) return this.options.chainTracker
      if (this.options.chaintracks == null) {
        throw new WERR_INVALID_PARAMETER(
          'options.chainTracker or options.chaintracks',
          "valid to enable 'getChainTracker' service."
        )
      }
      const desired = this.options.chaintracks
      if (this.identityChainTracker?.chaintracks === desired) return this.identityChainTracker
      if (this.identityChainTrackerInit != null) {
        await this.identityChainTrackerInit.catch(() => undefined)
        continue
      }
      const previous = this.identityChainTracker
      const created = new ChaintracksChainTracker(this.chain, desired, {
        telemetry: this.options.telemetry
      })
      this.identityChainTracker = created
      const init = Promise.resolve().then(async () => {
        if (previous != null) await previous.dispose()
        return created
      })
      this.identityChainTrackerInit = init
      try {
        await init.catch(() => created)
      } finally {
        if (this.identityChainTrackerInit === init) this.identityChainTrackerInit = undefined
      }
    }
  }

  async getBsvExchangeRate(): Promise<number> {
    this.options.bsvExchangeRate = await this.whatsonchain.updateBsvExchangeRate(
      this.options.bsvExchangeRate,
      this.options.bsvUpdateMsecs
    )
    return this.options.bsvExchangeRate.rate
  }

  async getFiatExchangeRate(currency: FiatCurrencyCode, base?: FiatCurrencyCode): Promise<number> {
    const normalizedCurrency = normalizeFiatCurrency(currency)
    const normalizedBase = normalizeFiatCurrency(base ?? 'USD', 'base')
    if (normalizedCurrency === normalizedBase) return 1

    const required: FiatCurrencyCode[] =
      normalizedBase === 'USD' ? [normalizedCurrency] : [normalizedCurrency, normalizedBase]
    const rates = await this.updateFiatExchangeRates(required, this.options.fiatUpdateMsecs)
    const c = rates.rates?.[normalizedCurrency]
    const b = rates.rates?.[normalizedBase]
    if (!isValidFiatRate(c)) {
      throw new WERR_INVALID_PARAMETER('currency', `valid fiat currency '${normalizedCurrency}' with an exchange rate.`)
    }
    if (!isValidFiatRate(b)) {
      throw new WERR_INVALID_PARAMETER('base', `valid fiat currency '${normalizedBase}' with an exchange rate.`)
    }
    const result = c / b
    if (!isValidFiatRate(result)) {
      throw new WERR_INVALID_PARAMETER('currency', 'a finite and bounded conversion result.')
    }
    return result
  }

  async getFiatExchangeRates(targetCurrencies: FiatCurrencyCode[]): Promise<FiatExchangeRates> {
    const targets = normalizeFiatCurrencies(targetCurrencies)
    const stored = await this.updateFiatExchangeRates(targets, this.options.fiatUpdateMsecs)
    const rates: Record<string, number> = {}
    for (const c of targets) {
      const v = stored.rates?.[c]
      if (isValidFiatRate(v)) {
        rates[c] = v
      }
    }

    return {
      timestamp: new Date(stored.timestamp.getTime()),
      base: 'USD',
      rates,
      rateTimestamps:
        stored.rateTimestamps == null
          ? undefined
          : Object.fromEntries(
              Object.entries(stored.rateTimestamps).map(([key, value]) => [key, new Date(value.getTime())])
            )
    }
  }

  get getProofsCount(): number {
    return this.getMerklePathServices.count
  }

  get getRawTxsCount(): number {
    return this.getRawTxServices.count
  }

  get postBeefServicesCount(): number {
    return this.postBeefServices.count
  }

  get getUtxoStatsCount(): number {
    return this.getUtxoStatusServices.count
  }

  async getStatusForTxids(txids: string[], useNext?: boolean): Promise<GetStatusForTxidsResult> {
    const services = this.getStatusForTxidsServices
    if (useNext === true) services.next()
    const normalizedTxids = txids.map((txid, index) => normalizeTxid(txid, `txids[${index}]`))

    let fallback: GetStatusForTxidsResult = {
      name: '<noservices>',
      status: 'error',
      error: new WERR_INTERNAL('No services available.'),
      results: []
    }
    const resultsByTxid = new Map<string, GetStatusForTxidsResult['results'][number]>()
    const unresolved = new Set(normalizedTxids)
    const providerNames: string[] = []
    let successfulProvider = false

    const rank = (result: GetStatusForTxidsResult['results'][number]): number => {
      if (result.status === 'mined') return 4
      if (result.status === 'known') return 3
      if (result.terminal === true) return 2
      return 1
    }

    for (let tries = 0; tries < services.count; tries++) {
      const stc = services.serviceToCall
      try {
        const requestedTxids = [...unresolved]
        if (requestedTxids.length === 0) break
        const r = await this.getStatusForTxidsBatched(stc, requestedTxids)
        if (r.status === 'success') {
          services.addServiceCallSuccess(stc)
          successfulProvider = true
          providerNames.push(stc.providerName)
          for (const result of r.results) {
            const current = resultsByTxid.get(result.txid)
            if (current == null || rank(result) > rank(current)) resultsByTxid.set(result.txid, result)
            if (result.status === 'mined' || result.status === 'known') unresolved.delete(result.txid)
          }
          services.next()
          continue
        }
        fallback = r
        if (r.error != null) services.addServiceCallError(stc, r.error)
        else services.addServiceCallFailure(stc)
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        fallback = { name: stc.providerName, status: 'error', error: e, results: [] }
        services.addServiceCallError(stc, e)
      }
      services.next()
    }

    if (!successfulProvider) return fallback
    return {
      name: [...new Set(providerNames)].join(','),
      status: 'success',
      results: normalizedTxids.map(txid => resultsByTxid.get(txid) ?? { txid, status: 'unknown', depth: undefined })
    }
  }

  private async getStatusForTxidsBatched(
    stc: ServiceToCall<GetStatusForTxidsService>,
    txids: string[]
  ): Promise<GetStatusForTxidsResult> {
    const results: GetStatusForTxidsResult['results'] = []
    let error: GetStatusForTxidsResult['error']

    for (let i = 0; i < txids.length; i += Services.getStatusForTxidsBatchLimit) {
      const batch = txids.slice(i, i + Services.getStatusForTxidsBatchLimit)
      const r = validateStatusForTxidsResult(await stc.service(batch), batch, stc.providerName)
      if (r.status !== 'success') {
        return r
      }
      if (error == null && r.error != null) error = r.error
      results.push(...r.results)
    }

    return {
      name: stc.providerName,
      status: 'success',
      error,
      results
    }
  }

  /**
   * @param script Output script to be hashed for `getUtxoStatus` default `outputFormat`
   * @returns script hash in 'hashLE' format, which is the default.
   */
  hashOutputScript(script: string): string {
    const hash = toHex(sha256Hash(toArray(script, 'hex')))
    return hash
  }

  async isUtxo(output: TableOutput): Promise<boolean> {
    return requireConclusiveUtxo(await classifyOutputUtxo(this, output))
  }

  async getUtxoStatus(
    output: string,
    outputFormat?: GetUtxoStatusOutputFormat,
    outpoint?: string,
    useNext?: boolean,
    logger?: WalletLoggerInterface
  ): Promise<GetUtxoStatusResult> {
    validateScriptHash(output, outputFormat)
    const normalizedOutput = output.toLowerCase()
    const normalizedOutpoint = normalizeWalletOutpoint(outpoint)
    const services = this.getUtxoStatusServices
    if (useNext === true) services.next()

    let r0: GetUtxoStatusResult = {
      name: '<noservices>',
      status: 'error',
      error: new WERR_INTERNAL('No services available.'),
      details: []
    }

    logger?.group('services getUtxoStatus')
    for (let retry = 0; retry < 2; retry++) {
      r0 =
        (await this.tryUtxoStatusProviders(services, normalizedOutput, outputFormat, normalizedOutpoint, logger)) ?? r0
      if (r0.status === 'success') break
      await wait(2000)
    }
    logger?.groupEnd()
    return r0
  }

  private async tryUtxoStatusProviders(
    services: ServiceCollection<GetUtxoStatusService>,
    output: string,
    outputFormat: GetUtxoStatusOutputFormat | undefined,
    outpoint: string | undefined,
    logger?: WalletLoggerInterface
  ): Promise<GetUtxoStatusResult | undefined> {
    for (let tries = 0; tries < services.count; tries++) {
      const stc = services.serviceToCall
      try {
        const r = validateUtxoStatusResult(
          await stc.service(output, outputFormat, outpoint),
          outpoint,
          stc.providerName
        )
        logger?.log(`${stc.providerName} status ${r.status}`)
        if (r.status === 'success') {
          services.addServiceCallSuccess(stc)
          return r
        }
        if (r.error != null) services.addServiceCallError(stc, r.error)
        else services.addServiceCallFailure(stc)
      } catch (error_: unknown) {
        services.addServiceCallError(stc, WalletError.fromUnknown(error_))
      }
      services.next()
    }
    return undefined
  }

  async getScriptHashHistory(
    hash: string,
    useNext?: boolean,
    logger?: WalletLoggerInterface
  ): Promise<GetScriptHashHistoryResult> {
    const normalizedHash = normalizeTxid(hash, 'hash')
    const services = this.getScriptHashHistoryServices
    if (useNext === true) services.next()

    let r0: GetScriptHashHistoryResult = {
      name: '<noservices>',
      status: 'error',
      error: new WERR_INTERNAL('No services available.'),
      history: []
    }

    logger?.group('services getScriptHashHistory')
    for (let tries = 0; tries < services.count; tries++) {
      const stc = services.serviceToCall
      try {
        const r = validateScriptHashHistoryResult(await stc.service(normalizedHash), stc.providerName)
        logger?.log(`${stc.providerName} status ${r.status}`)
        if (r.status === 'success') {
          r0 = r
          services.addServiceCallSuccess(stc)
          break
        }
        if (r.error != null) services.addServiceCallError(stc, r.error)
        else services.addServiceCallFailure(stc)
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        services.addServiceCallError(stc, e)
      }
      services.next()
    }
    logger?.groupEnd()
    return r0
  }

  postBeefMode: 'PromiseAll' | 'UntilSuccess' = 'UntilSuccess'
  /**
   * Soft timeout used for each provider call in `UntilSuccess` mode.
   * This bounds request latency when a provider hangs before failover.
   */
  postBeefUntilSuccessSoftTimeoutMs = 5000
  /**
   * Additional soft-timeout budget (ms) per KiB of serialized Beef payload.
   * Helps avoid false timeout failover on legitimately large submissions.
   */
  postBeefUntilSuccessSoftTimeoutPerKbMs = 50
  /**
   * Upper bound for adaptive soft-timeout in `UntilSuccess` mode.
   */
  postBeefUntilSuccessSoftTimeoutMaxMs = 30000

  /**
   *
   * @param beef
   * @param chain
   * @returns
   */
  async postBeef(beef: Beef, txids: string[], logger?: WalletLoggerInterface): Promise<PostBeefResult[]> {
    const request = snapshotPostBeefRequest(beef, txids)
    if (this.postBeefMode !== 'UntilSuccess' && this.postBeefMode !== 'PromiseAll') {
      throw new WERR_INVALID_PARAMETER('postBeefMode', "'UntilSuccess' or 'PromiseAll'")
    }
    let rs: PostBeefResult[] = []
    const services = this.postBeefServices
    const stcs = services.allServicesToCall
    const softTimeoutMs = this.getPostBeefSoftTimeoutMs(request.beefBytes.length)
    const softTimedOut = new Set<ServiceToCall<PostBeefService>>()
    logger?.group('services postBeef')
    switch (this.postBeefMode) {
      case 'UntilSuccess':
        for (const stc of stcs) {
          const r = await callService(stc, softTimeoutMs)
          logger?.log(`${stc.providerName} status ${r.status}`)
          rs.push(r)
          if (r.status === 'success') break
          if (!softTimedOut.has(stc) && r.txidResults.every(txr => txr.serviceError)) {
            // move this service to the end of the list
            this.postBeefServices.moveServiceToLast(stc)
          }
        }
        break
      case 'PromiseAll':
        rs = await Promise.all(
          stcs.map(async stc => {
            const r = await callService(stc)
            return r
          })
        )
        break
    }
    logger?.groupEnd()
    return rs

    async function callService(stc: ServiceToCall<PostBeefService>, timeoutMs?: number): Promise<PostBeefResult> {
      const callPromise = Promise.resolve()
        .then(async () => await stc.service(Beef.fromBinaryStrict(request.beefBytes), [...request.txids]))
        .then(result => validatePostBeefResult(result, request.txids, stc.providerName))
        .catch(() => makePostBeefServiceError(stc.providerName, request.txids, 'postBeefServiceError'))
      let r: PostBeefResult
      if (timeoutMs == null || timeoutMs <= 0) {
        r = await callPromise
      } else {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<PostBeefResult>(resolve => {
          timeoutHandle = setTimeout(() => {
            softTimedOut.add(stc)
            resolve(makePostBeefServiceError(stc.providerName, request.txids, 'postBeefServiceTimeout', timeoutMs))
          }, timeoutMs)
        })
        r = await Promise.race([callPromise, timeoutPromise])
        if (timeoutHandle != null) clearTimeout(timeoutHandle)
        // Avoid unhandled rejection after timeout race wins.
        void callPromise.catch(() => undefined)
      }

      if (r.status === 'success') {
        services.addServiceCallSuccess(stc)
      } else if (r.error != null) {
        services.addServiceCallError(stc, r.error)
      } else {
        services.addServiceCallFailure(stc)
      }
      return r
    }
  }

  private getPostBeefSoftTimeoutMs(beefBytes: number): number {
    const maximum = 60 * 60 * 1000
    const valid = (value: unknown, name: string): number => {
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
        throw new WERR_INVALID_PARAMETER(name, `an integer from 0 through ${maximum}`)
      }
      return value as number
    }
    const baseMs = valid(this.postBeefUntilSuccessSoftTimeoutMs, 'postBeefUntilSuccessSoftTimeoutMs')
    const perKbMs = valid(this.postBeefUntilSuccessSoftTimeoutPerKbMs, 'postBeefUntilSuccessSoftTimeoutPerKbMs')
    const maxMs = Math.max(
      baseMs,
      valid(this.postBeefUntilSuccessSoftTimeoutMaxMs, 'postBeefUntilSuccessSoftTimeoutMaxMs')
    )
    if (perKbMs <= 0) return Math.min(baseMs, maxMs)

    const extraMs = Math.ceil((beefBytes / 1024) * perKbMs)
    return Math.min(maxMs, baseMs + extraMs)
  }

  async getRawTx(txid: string, useNext?: boolean): Promise<GetRawTxResult> {
    const normalizedTxid = normalizeTxid(txid)
    const services = this.getRawTxServices
    if (useNext === true) services.next()

    const r0: GetRawTxResult = { txid: normalizedTxid }

    for (let tries = 0; tries < services.count; tries++) {
      const stc = services.serviceToCall
      try {
        const result = validateRawTxResult(
          await stc.service(normalizedTxid, this.chain),
          normalizedTxid,
          stc.providerName
        )
        const done = this.applyRawTxResult(r0, normalizedTxid, result, services, stc)
        if (done) break
      } catch (error_: unknown) {
        services.addServiceCallError(stc, WalletError.fromUnknown(error_))
      }
      services.next()
    }
    return r0
  }

  private applyRawTxResult(
    r0: GetRawTxResult,
    txid: string,
    r: GetRawTxResult,
    services: ServiceCollection<GetRawTxService>,
    stc: ServiceToCall<GetRawTxService>
  ): boolean {
    if (r.rawTx != null) {
      const hash = asString(doubleSha256BE(r.rawTx))
      if (hash === txid) {
        r0.rawTx = r.rawTx
        r0.name = stc.providerName
        r0.error = undefined
        services.addServiceCallSuccess(stc)
        return true
      }
      r.error = new WERR_INTERNAL(`computed txid ${hash} doesn't match requested value ${txid}`)
      r.rawTx = undefined
    }

    if (r.error != null) services.addServiceCallError(stc, r.error)
    else services.addServiceCallSuccess(stc, 'not found')

    // If we have an error and didn't before, capture it.
    if (r.error != null && r0.error == null && r0.rawTx == null) r0.error = r.error
    return false
  }

  async invokeChaintracksWithRetry<R>(method: () => Promise<R>, operation: string = 'unknown'): Promise<R> {
    if (this.options.chaintracks == null) {
      throw new WERR_INVALID_PARAMETER('options.chaintracks', 'valid for this service operation.')
    }
    if (!this.telemetry.enabled) return await this.invokeChaintracksWithRetryCore(method)
    return await this.telemetry.withSpan(
      'wallet.chaintracks.request',
      {
        component: 'wallet-services',
        kind: 'client',
        attributes: {
          'chaintracks.operation': operation
        }
      },
      async span => await this.invokeChaintracksWithRetryCore(method, span)
    )
  }

  private async invokeChaintracksWithRetryCore<R>(method: () => Promise<R>, parent?: TelemetrySpan): Promise<R> {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r: R =
          parent == null
            ? await method()
            : await this.telemetry.withSpan(
                'wallet.chaintracks.attempt',
                {
                  component: 'wallet-services',
                  kind: 'client',
                  parent: parent.context,
                  attributes: {
                    'retry.attempt': retry + 1
                  }
                },
                method
              )
        return r
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        if (e.code !== 'ECONNRESET') throw error_
      }
    }
    throw new WERR_INVALID_OPERATION('hashToHeader service unavailable')
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    const method = async (): Promise<number[]> => {
      const chaintracks = this.options.chaintracks as NonNullable<typeof this.options.chaintracks>
      const header = await chaintracks.findHeaderForHeight(height)
      if (header == null)
        throw new WERR_INVALID_PARAMETER('hash', `valid height '${height}' on mined chain ${this.chain}`)
      return toBinaryBaseBlockHeader(header)
    }
    return await this.invokeChaintracksWithRetry(method, 'find_header_for_height')
  }

  async getHeight(): Promise<number> {
    const method = async (): Promise<number> => {
      const chaintracks = this.options.chaintracks as NonNullable<typeof this.options.chaintracks>
      return await chaintracks.currentHeight()
    }
    try {
      return await this.invokeChaintracksWithRetry(method, 'current_height')
    } catch (error_: unknown) {
      // Chaintracks is otherwise this method's single point of failure, and a
      // wallet UI that cannot read the present height is broadly unusable
      // (observed live 2026-08-11: a CORS-blocked chaintracks fetch in a
      // webview-hosted wallet). Mirror `hashToHeader`'s existing belt: fall
      // back to WhatsOnChain, and rethrow the ORIGINAL chaintracks error when
      // the fallback cannot answer either.
      try {
        return (await this.whatsonchain.getChainInfo()).blocks
      } catch {
        throw error_
      }
    }
  }

  async hashToHeader(hash: string): Promise<BlockHeader> {
    const normalizedHash = normalizeTxid(hash, 'hash')
    const method = async (): Promise<BlockHeader | undefined> => {
      const chaintracks = this.options.chaintracks as NonNullable<typeof this.options.chaintracks>
      const header = await chaintracks.findHeaderForBlockHash(normalizedHash)
      return header
    }
    let header = await this.invokeChaintracksWithRetry(method, 'find_header_for_hash')
    header ??= await this.whatsonchain.getBlockHeaderByHash(normalizedHash)
    if (header == null)
      throw new WERR_INVALID_PARAMETER('hash', `valid blockhash '${normalizedHash}' on mined chain ${this.chain}`)
    const validated = copyValidatedBlockHeader(header, true, true, this.chain)
    if (validated.hash !== normalizedHash) {
      throw new WERR_INVALID_PARAMETER('hash', `the hash of the returned mined header on chain ${this.chain}`)
    }
    return validated
  }

  private async authenticateProviderMerklePath(
    txid: string,
    result: GetMerklePathResult
  ): Promise<ValidatedMerklePathResult> {
    // First copy and bind the provider's mutable proof/header response. Then
    // resolve that header hash through the wallet's own chain service and bind
    // the proof a second time to that canonical, proof-of-work-valid header.
    // Bind the provider path to the declared height/root before using the
    // declared hash as a lookup key. `hashToHeader` then authenticates that
    // hash and returns the canonical owned header.
    const providerResult = validateMerklePathResult(txid, result, false, false)
    const canonicalHeader = await this.hashToHeader(providerResult.header.hash)
    // `hashToHeader` already returns an owned, format-checked,
    // proof-of-work-valid header. This second pass only binds the copied path
    // to that canonical header's height and root.
    return validateMerklePathResult(
      txid,
      { merklePath: providerResult.merklePath, header: canonicalHeader },
      false,
      false
    )
  }

  private async tryMerklePathProvider(
    txid: string,
    service: ServiceToCall<GetMerklePathService>,
    aggregate: GetMerklePathResult,
    logger?: WalletLoggerInterface
  ): Promise<boolean> {
    let result: GetMerklePathResult
    try {
      result = snapshotMerklePathResult(
        await service.service(txid, this),
        true,
        service.providerName
      ) as GetMerklePathResult
    } catch (error_: unknown) {
      const error = WalletError.fromUnknown(error_)
      this.getMerklePathServices.addServiceCallError(service, error)
      aggregate.error ??= error
      return false
    }

    aggregate.notes?.push(...(result.notes ?? []))
    aggregate.name ??= result.name ?? service.providerName
    if (result.merklePath != null) {
      try {
        await validateCanonicalMerklePathResult(txid, result, await this.getChainTracker())
        if (result.header != null) {
          const authenticated = await this.authenticateProviderMerklePath(txid, result)
          result.merklePath = authenticated.merklePath
          result.header = authenticated.header
        }
        logger?.log(`${service.providerName} has authenticated canonical merklePath`)
        Object.assign(aggregate, {
          merklePath: result.merklePath,
          header: result.header,
          name: result.name ?? service.providerName,
          error: undefined
        })
        this.getMerklePathServices.addServiceCallSuccess(service)
        return true
      } catch (error_: unknown) {
        logger?.log(`${service.providerName} rejected non-canonical merklePath`)
        result.error = WalletError.fromUnknown(error_)
      }
    } else {
      logger?.log(`${service.providerName} no merklePath`)
    }

    if (result.error != null) this.getMerklePathServices.addServiceCallError(service, result.error)
    else this.getMerklePathServices.addServiceCallFailure(service)
    aggregate.error ??= result.error
    return false
  }

  async getMerklePath(txid: string, useNext?: boolean, logger?: WalletLoggerInterface): Promise<GetMerklePathResult> {
    const normalizedTxid = normalizeTxid(txid)
    const services = this.getMerklePathServices
    if (useNext === true) services.next()

    const result: GetMerklePathResult = { notes: [] }

    logger?.group('services getMerklePath')
    for (let tries = 0; tries < services.count; tries++) {
      if (await this.tryMerklePathProvider(normalizedTxid, services.serviceToCall, result, logger)) break
      services.next()
    }
    logger?.groupEnd?.()
    return result
  }

  async getValidatedMerklePath(
    txid: string,
    validate: (result: GetMerklePathResult) => Promise<void>
  ): Promise<GetMerklePathResult> {
    const normalizedTxid = normalizeTxid(txid)
    const services = this.getMerklePathServices
    const calls = services.allServicesToCall
    const start = services.index
    let error: WalletError | undefined
    for (let i = 0; i < calls.length; i++) {
      const call = calls[(start + i) % calls.length]
      try {
        const result = snapshotMerklePathResult(
          await call.service(normalizedTxid, this),
          true,
          call.providerName
        ) as GetMerklePathResult
        if (result.merklePath == null) {
          throw result.error ?? new WERR_INVALID_OPERATION('Proof provider returned no Merkle path')
        }
        await validateCanonicalMerklePathResult(normalizedTxid, result, await this.getChainTracker())
        // Some legacy/custom proof providers return a path without a header;
        // this method's explicit validator contract exists so its caller can
        // resolve and authenticate that header independently. When a provider
        // does supply a header, apply the standard built-in boundary first.
        let candidate = result
        if (result.header != null) {
          const authenticated = await this.authenticateProviderMerklePath(normalizedTxid, result)
          candidate = {
            name: call.providerName,
            notes: result.notes,
            merklePath: authenticated.merklePath,
            header: authenticated.header
          }
        }
        await validate(candidate)
        services.addServiceCallSuccess(call)
        return candidate
      } catch (cause) {
        error = WalletError.fromUnknown(cause)
        services.addServiceCallError(call, error)
      }
    }
    return { error, notes: [] }
  }

  async updateFiatExchangeRates(
    targetCurrencies: FiatCurrencyCode[],
    updateMsecs?: number
  ): Promise<FiatExchangeRates> {
    updateMsecs ??= 1000 * 60 * 60 * 24
    if (!Number.isSafeInteger(updateMsecs) || updateMsecs < 0 || updateMsecs > 10 * 365 * 24 * 60 * 60 * 1000) {
      throw new WERR_INVALID_PARAMETER('updateMsecs', 'a bounded non-negative safe integer.')
    }
    const targets = normalizeFiatCurrencies(targetCurrencies)
    const freshnessDate = new Date(Date.now() - updateMsecs)

    let stored: FiatExchangeRates
    try {
      const normalized = normalizeFiatExchangeRates(this.options.fiatExchangeRates, [])
      stored = {
        ...normalized,
        rateTimestamps: normalizeFiatRateTimestamps(this.options.fiatExchangeRates.rateTimestamps)
      }
    } catch {
      stored = {
        timestamp: new Date(Date.UTC(2000, 0, 1)),
        base: 'USD',
        rates: { USD: 1 }
      }
    }
    const storedRates = stored.rates ?? {}

    const toFetch = this.collectStaleCurrencies(targets, storedRates, stored, freshnessDate)

    if (toFetch.length === 0) {
      this.options.fiatExchangeRates = {
        timestamp: stored.timestamp,
        base: stored.base,
        rates: storedRates,
        rateTimestamps: stored.rateTimestamps
      }
      return copyFiatExchangeRates(this.options.fiatExchangeRates)
    }

    const fetched = await this.fetchFiatRates(toFetch)

    if (fetched == null) {
      if (Object.keys(storedRates).length > 0) return copyFiatExchangeRates(stored)
      throw new WERR_INTERNAL()
    }

    this.options.fiatExchangeRates = this.mergeFiatRates(stored, storedRates, fetched)
    return copyFiatExchangeRates(this.options.fiatExchangeRates)
  }

  private collectStaleCurrencies(
    targetCurrencies: FiatCurrencyCode[],
    storedRates: Record<string, number>,
    stored: FiatExchangeRates,
    freshnessDate: Date
  ): FiatCurrencyCode[] {
    const toFetch: FiatCurrencyCode[] = []
    for (const c of targetCurrencies) {
      if (c === 'USD') {
        if (typeof storedRates.USD !== 'number') storedRates.USD = 1
        continue
      }
      const v = storedRates[c]
      const ts = stored.rateTimestamps?.[c] ?? stored.timestamp
      const tsValue = ts instanceof Date ? ts.getTime() : Number.NaN
      const fresh =
        isValidFiatRate(v) && Number.isFinite(tsValue) && tsValue <= Date.now() + 5 * 60 * 1000 && ts > freshnessDate
      if (!fresh) toFetch.push(c)
    }
    return toFetch
  }

  private async fetchFiatRates(toFetch: FiatCurrencyCode[]): Promise<FiatExchangeRates | undefined> {
    const services = this.updateFiatExchangeRateServices.clone()
    for (let tries = 0; tries < services.count; tries++) {
      const stc = services.serviceToCall
      try {
        const raw = await stc.service(toFetch as string[], this.options)
        const rates = normalizeFiatExchangeRates(raw, toFetch)
        services.addServiceCallSuccess(stc)
        return rates
      } catch (error_: unknown) {
        services.addServiceCallError(stc, WalletError.fromUnknown(error_))
      }
      services.next()
    }
    return undefined
  }

  private mergeFiatRates(
    stored: FiatExchangeRates,
    storedRates: Record<string, number>,
    fetched: FiatExchangeRates
  ): FiatExchangeRates {
    fetched = normalizeFiatExchangeRates(fetched, [])
    const nextRates: Record<string, number> = { ...storedRates }
    const nextTimestamps: Record<string, Date> = { ...stored.rateTimestamps }

    for (const c of fetched.rates != null ? Object.keys(fetched.rates) : []) {
      const v = fetched.rates?.[c]
      if (isValidFiatRate(v)) {
        nextRates[c] = v
        nextTimestamps[c] = fetched.timestamp
      }
    }

    const storedMs =
      stored.timestamp instanceof Date ? stored.timestamp.getTime() : new Date(stored.timestamp).getTime()
    const nextTimestamp = new Date(Math.max(storedMs, fetched.timestamp.getTime()))

    return { timestamp: nextTimestamp, base: stored.base, rates: nextRates, rateTimestamps: nextTimestamps }
  }

  async nLockTimeIsFinal(tx: string | number[] | BsvTransaction | number): Promise<boolean> {
    const MAXINT = 0xffffffff
    const BLOCK_LIMIT = 500000000

    let nLockTime: number

    if (typeof tx === 'number') nLockTime = tx
    else {
      if (typeof tx === 'string') {
        tx = BsvTransaction.fromHex(tx)
      } else if (Array.isArray(tx)) {
        tx = BsvTransaction.fromBinary(tx)
      }

      if (tx instanceof BsvTransaction) {
        if (tx.inputs.every(i => i.sequence === MAXINT)) {
          return true
        }
        nLockTime = tx.lockTime
      } else {
        throw new WERR_INTERNAL('Should be either @bsv/sdk Transaction or babbage-bsv Transaction')
      }
    }

    if (nLockTime >= BLOCK_LIMIT) {
      const limit = Math.floor(Date.now() / 1000)
      return nLockTime < limit
    }

    const height = await this.getHeight()
    return nLockTime < height
  }

  async getBeefForTxid(txid: string): Promise<Beef> {
    const beef = await getBeefForTxid(this, txid)
    return beef
  }
}

export function validateScriptHash(output: string, outputFormat?: GetUtxoStatusOutputFormat): string {
  if (
    typeof output !== 'string' ||
    output.length === 0 ||
    output.length % 2 !== 0 ||
    output.length > MAX_RAW_TRANSACTION_BYTES * 2 ||
    !/^[0-9a-fA-F]+$/.test(output)
  ) {
    throw new WERR_INVALID_PARAMETER('output', `nonempty hexadecimal bytes up to ${MAX_RAW_TRANSACTION_BYTES} bytes`)
  }
  let b = asArray(output)
  if (outputFormat == null) {
    if (b.length === 32) outputFormat = 'hashLE'
    else outputFormat = 'script'
  }
  switch (outputFormat) {
    case 'hashBE':
      if (b.length !== 32) throw new WERR_INVALID_PARAMETER('output', 'exactly 32 bytes for hashBE')
      break
    case 'hashLE':
      if (b.length !== 32) throw new WERR_INVALID_PARAMETER('output', 'exactly 32 bytes for hashLE')
      b = b.reverse()
      break
    case 'script':
      b = sha256Hash(b).reverse()
      break
    default:
      throw new WERR_INVALID_PARAMETER('outputFormat', `not be ${String(outputFormat)}`)
  }
  return asString(b)
}

/**
 * Serializes a block header as an 80 byte array.
 * The exact serialized format is defined in the Bitcoin White Paper
 * such that computing a double sha256 hash of the array computes
 * the block hash for the header.
 * @returns 80 byte array
 * @publicbody
 */
export function toBinaryBaseBlockHeader(header: BaseBlockHeader): number[] {
  const writer = new Writer()
  writer.writeUInt32LE(header.version)
  writer.writeReverse(asArray(header.previousHash))
  writer.writeReverse(asArray(header.merkleRoot))
  writer.writeUInt32LE(header.time)
  writer.writeUInt32LE(header.bits)
  writer.writeUInt32LE(header.nonce)
  const r = writer.toArray()
  return r
}
