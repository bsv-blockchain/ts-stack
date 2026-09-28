import {
  LookupService,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent,
  LookupServiceMetaData
} from '@bsv/overlay'
import { LookupQuestion } from '@bsv/sdk'

/**
 * Pushes the engine lookup ceiling into the built-in SHIP/SLAP services so a
 * remote lookup cannot materialize an unbounded MongoDB result before Engine
 * gets a chance to enforce its response limit.
 *
 * One extra row is requested deliberately. Engine turns that row into a clear
 * range error instead of returning a silently truncated discovery result.
 */
export class ResourceBoundedLookupWrapper implements LookupService {
  readonly admissionMode: AdmissionMode
  readonly spendNotificationMode: SpendNotificationMode

  constructor(
    private readonly wrapped: LookupService,
    private readonly maxLookupResults: number
  ) {
    if (
      maxLookupResults !== -1 &&
      (!Number.isSafeInteger(maxLookupResults) || maxLookupResults < 1)
    ) {
      throw new TypeError('maxLookupResults must be -1 or a positive safe integer')
    }
    this.admissionMode = wrapped.admissionMode
    this.spendNotificationMode = wrapped.spendNotificationMode
  }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    return await this.wrapped.outputAdmittedByTopic(payload)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (typeof this.wrapped.outputSpent === 'function') {
      return await this.wrapped.outputSpent(payload)
    }
  }

  async outputNoLongerRetainedInHistory(
    txid: string,
    outputIndex: number,
    topic: string
  ): Promise<void> {
    if (typeof this.wrapped.outputNoLongerRetainedInHistory === 'function') {
      return await this.wrapped.outputNoLongerRetainedInHistory(txid, outputIndex, topic)
    }
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    return await this.wrapped.outputEvicted(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const bounded = this.boundQuestion(question)
    const query = bounded.query as Record<string, unknown>
    if (
      typeof query !== 'object' || query === null || Array.isArray(query) ||
      typeof query.limit !== 'number' || !Number.isSafeInteger(query.limit) ||
      query.limit <= 1000 || this.maxLookupResults === -1
    ) return await this.wrapped.lookup(bounded)

    // Discovery services accept at most 1000 rows per query. Preserve the
    // engine's extra-row overflow probe using bounded, deterministic pages.
    const skip = query.skip ?? 0
    if (typeof skip !== 'number' || !Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000) {
      return await this.wrapped.lookup(bounded)
    }
    const result: LookupFormula = []
    while (result.length < query.limit) {
      const pageSkip = skip + result.length
      if (pageSkip > 1_000_000) throw new RangeError('Discovery lookup exceeds the maximum skip')
      const pageLimit = Math.min(1000, query.limit - result.length)
      const page = await this.wrapped.lookup({
        ...bounded, query: { ...query, limit: pageLimit, skip: pageSkip }
      })
      if (!Array.isArray(page) || page.length > pageLimit) {
        throw new TypeError('Discovery lookup returned an invalid bounded page')
      }
      result.push(...page)
      if (page.length < pageLimit) break
    }
    return result
  }

  async getDocumentation(): Promise<string> {
    return await this.wrapped.getDocumentation()
  }

  async getMetaData(): Promise<LookupServiceMetaData> {
    return await this.wrapped.getMetaData()
  }

  private boundQuestion(question: LookupQuestion): LookupQuestion {
    if (this.maxLookupResults === -1) return question

    const probeLimit = this.maxLookupResults + 1
    if (question.query === 'findAll') {
      return { ...question, query: { findAll: true, limit: probeLimit } }
    }
    if (
      typeof question.query !== 'object' ||
      question.query === null ||
      Array.isArray(question.query)
    ) {
      return question
    }

    const query = question.query as Record<string, unknown>
    const requestedLimit = query.limit
    if (
      requestedLimit === undefined ||
      (typeof requestedLimit === 'number' && requestedLimit > probeLimit)
    ) {
      return { ...question, query: { ...query, limit: probeLimit } }
    }
    return question
  }
}
