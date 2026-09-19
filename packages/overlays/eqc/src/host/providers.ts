import type { LookupAnswer, LookupQuestion } from '@bsv/sdk'

import type { TopicAnchor } from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import {
  canonicalizeLookupAnswer,
  encodeMessageList,
  type CanonicalMessage
} from '../protocol/payloads.js'
import { isPublicKeyHex, type EconomicQuery } from '../protocol/query.js'

export interface ProviderResult {
  payload: number[]
  /** Bytes delivered with the payload but outside the content hash, such as BEEF. */
  supplement?: number[]
  extensions?: { anchors?: TopicAnchor[] }
}

export interface ProviderContext {
  clientIdentityKey: string
}

/** Answers one query class. Throw `HostError` for a caller mistake; anything else becomes a 500. */
export interface QueryProvider {
  readonly type: string
  execute: (query: EconomicQuery, context: ProviderContext) => Promise<ProviderResult>
}

/** The part of `@bsv/overlay` `Engine` this package uses, typed structurally. */
export interface LookupEngineLike {
  lookup: (question: LookupQuestion) => Promise<{ type: string; outputs?: unknown }>
  provideTopicAnchorTip?: (
    topic: string
  ) => Promise<{ topic: string; blockHeight: number; blockHash?: string; tac: string }>
}

function invalid(description: string): HostError {
  return new HostError(400, 'ERR_INVALID_QUERY', description)
}

async function readAnchors(engine: LookupEngineLike, topics: string[]): Promise<TopicAnchor[]> {
  const provide = engine.provideTopicAnchorTip?.bind(engine)
  if (provide === undefined) return []
  const anchors: TopicAnchor[] = []
  for (const topic of topics) {
    try {
      const tip = await provide(topic)
      const anchor: TopicAnchor = { topic, blockHeight: tip.blockHeight, tac: tip.tac }
      if (tip.blockHash !== undefined) anchor.blockHash = tip.blockHash
      anchors.push(anchor)
    } catch {
      // A node without BASM support still answers; the client reports its anchors as unknown.
    }
  }
  return anchors
}

/**
 * Races BRC-24 lookups. The hashed payload is the sorted outpoint section; BEEF travels as the
 * supplement because honest hosts hold different proof state for the same outputs.
 */
export function overlayLookupProvider(options: {
  engine: LookupEngineLike
  /** BRC-136 topics backing each lookup service, reported as topic anchors. */
  anchorTopics?: Record<string, string[]>
}): QueryProvider {
  return {
    type: 'overlay-lookup',
    async execute(query) {
      const { service, query: question } = query.params
      if (typeof service !== 'string' || service.length === 0 || service.length > 256) {
        throw invalid('params.service must name a lookup service')
      }
      const answer = await options.engine.lookup({ service, query: question })
      if (answer.type !== 'output-list' || !Array.isArray(answer.outputs)) {
        throw new HostError(422, 'ERR_UNSUPPORTED_CLASS', 'Only output-list answers can be raced')
      }
      const result: ProviderResult = canonicalizeLookupAnswer(answer as LookupAnswer)
      const anchors = await readAnchors(options.engine, options.anchorTopics?.[service] ?? [])
      if (anchors.length > 0) result.extensions = { anchors }
      return result
    }
  }
}

export interface MessageListSource {
  listMessages: (recipient: string, messageBox: string) => Promise<CanonicalMessage[]>
}

/** Races BRC-33 message listings. Only the authenticated recipient may list its own inbox. */
export function messageListProvider(source: MessageListSource): QueryProvider {
  return {
    type: 'message-list',
    async execute(query, context) {
      const { recipient, messageBox } = query.params
      if (!isPublicKeyHex(recipient)) throw invalid('params.recipient must be an identity key')
      if (recipient !== context.clientIdentityKey) {
        throw new HostError(
          403,
          'ERR_FORBIDDEN_RECIPIENT',
          'Only the recipient may list its messages'
        )
      }
      if (typeof messageBox !== 'string' || messageBox.length === 0 || messageBox.length > 128) {
        throw invalid('params.messageBox must name a message box')
      }
      return { payload: encodeMessageList(await source.listMessages(recipient, messageBox)) }
    }
  }
}

/** Races any read whose answer is a byte string, such as `relay-lookup` or `message-body`. */
export function bytesProvider(
  type: string,
  resolve: (
    params: Record<string, unknown>,
    context: ProviderContext
  ) => Promise<number[] | undefined>
): QueryProvider {
  return {
    type,
    async execute(query, context) {
      const payload = await resolve(query.params, context)
      if (payload === undefined) throw invalid('No payload exists for these parameters')
      return { payload }
    }
  }
}
