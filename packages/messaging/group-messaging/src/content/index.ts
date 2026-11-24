/**
 * The v1 JSON content envelope: what a message *is*, once MLS has opened it.
 *
 * An application-specific type needs no registration. Set `type` to your own
 * string, put a human-readable summary in `body` for clients that do not know
 * it, and hang the structured payload off `extra`. `sendContent` takes the
 * envelope as-is and `decodeContent` returns it untouched.
 */
import { GroupMessagingError } from '../errors.js'
import { CONTENT_VERSION, type MessageContent } from './types.js'

export * from './types.js'

export class ContentDecodeError extends GroupMessagingError {
  override name = 'ContentDecodeError'
}

export const encodeContent = (content: MessageContent): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(content))

/** The only two fields declared `| null`; everywhere else null is a wrong kind. */
const NULLABLE: ReadonlySet<keyof MessageContent> = new Set(['replyTo', 'expires'])

const matchesKind = (value: unknown, kind: 'string' | 'array' | 'object'): boolean => {
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return typeof value === 'object' && !Array.isArray(value)
  return typeof value === kind
}

const requireKind = (
  content: Partial<MessageContent>,
  field: keyof MessageContent,
  kind: 'string' | 'array' | 'object'
): void => {
  const value = content[field]
  if (value === undefined) return
  if (value === null) {
    if (NULLABLE.has(field)) return
    throw new ContentDecodeError(`Message content field ${field} is null, not a ${kind}`)
  }
  if (!matchesKind(value, kind)) {
    throw new ContentDecodeError(`Message content field ${field} is not a ${kind}`)
  }
}

export const decodeContent = (bytes: Uint8Array): MessageContent => {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (cause) {
    throw new ContentDecodeError('Message content is not valid JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ContentDecodeError('Message content is not an object')
  }
  const content = parsed as Partial<MessageContent>
  if (typeof content.v !== 'number') {
    throw new ContentDecodeError('Message content is missing a version')
  }
  if (typeof content.type !== 'string') {
    throw new ContentDecodeError('Message content is missing a type')
  }
  // Kinds only: any member can send these, and a consumer rendering `body` or
  // spreading `extra` is entitled to believe the declared shape. Element
  // contents stay the consumer's to check — an attachment's fields are its
  // own business, and validating them here would make this a schema validator.
  requireKind(content, 'body', 'string')
  requireKind(content, 'markdown', 'string')
  requireKind(content, 'replyTo', 'string')
  requireKind(content, 'expires', 'string')
  requireKind(content, 'attachments', 'array')
  requireKind(content, 'mentions', 'array')
  requireKind(content, 'linkPreviews', 'array')
  requireKind(content, 'reaction', 'object')
  requireKind(content, 'extra', 'object')
  return content as MessageContent
}

export const text = (body: string): MessageContent => ({
  v: CONTENT_VERSION,
  type: 'text',
  body
})

/**
 * `body` is the plain-text fallback. When the caller does not supply one, the
 * Markdown source stands in — a poor fallback beats an absent one, since
 * notifications and search read `body`.
 */
export const markdown = (source: string, body?: string): MessageContent => ({
  v: CONTENT_VERSION,
  type: 'markdown',
  body: body ?? source,
  markdown: source
})
