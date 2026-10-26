import { SHA256 } from '@bsv/sdk/primitives/Hash'

/**
 * Represents a capability in the BSV Paymail protocol.
 * A capability is essentially a feature or service offered by a Paymail provider.
 */
export default class Capability {
  /**
   * The unique code identifying the capability.
   */
  private readonly code: string

  /**
   * The title of the capability.
   */
  private readonly title: string

  /**
   * The authors of the capability.
   */
  private readonly authors: readonly string[]

  /**
   * The version of the capability.
   */
  private readonly version?: string

  /**
   * Other capabilities that this one supersedes.
   */
  private readonly supersedes?: readonly string[]

  /**
   * The HTTP method used by the capability (GET or POST).
   */
  private readonly method?: 'GET' | 'POST'

  /**
   * Constructs a new Capability instance.
   * @param params - The parameters for the capability.
   */
  constructor({
    code,
    title,
    authors,
    version,
    supersedes,
    method
  }: {
    code?: string
    title: string
    authors?: string[]
    version?: string
    supersedes?: string[]
    method?: 'GET' | 'POST'
  }) {
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 1024) {
      throw new Error('Capability requires a non-empty title of at most 1024 characters')
    }
    if (!this.isStringArray(authors, 32, 512)) {
      throw new TypeError('Capability authors must be an array of at most 32 non-empty strings')
    }
    if (typeof version !== 'undefined' && (typeof version !== 'string' || version.length > 128)) {
      throw new TypeError('Capability version must be a string of at most 128 characters')
    }
    if (!this.isStringArray(supersedes, 64, 256)) {
      throw new TypeError('Capability supersedes must be an array of at most 64 non-empty strings')
    }
    if (method !== undefined && method !== 'GET' && method !== 'POST') {
      throw new TypeError('Capability method must be GET or POST')
    }
    this.title = title
    this.authors = Object.freeze([...(authors ?? [])])
    this.version = version
    this.supersedes = supersedes == null ? undefined : Object.freeze([...supersedes])
    this.method = method
    const resolvedCode = code ?? this.bfrc()
    if (
      typeof resolvedCode !== 'string' ||
      resolvedCode.length === 0 ||
      resolvedCode.length > 256 ||
      this.hasControlCharacter(resolvedCode) ||
      resolvedCode === '__proto__' ||
      resolvedCode === 'constructor' ||
      resolvedCode === 'prototype'
    ) {
      throw new TypeError('Capability code is invalid')
    }
    this.code = resolvedCode
  }

  /**
   * Retrieves the code of the capability.
   * @returns The capability code or a generated code if not explicitly set.
   */
  public getCode(): string {
    return this.code
  }

  /**
   * Retrieves the HTTP method of the capability.
   * @returns The HTTP method ('GET' or 'POST').
   */
  public getMethod(): 'GET' | 'POST' {
    return this.method || 'GET'
  }

  /**
   * Generates a unique code based on the capability's properties.
   * This is used when an explicit code is not provided.
   * @returns A generated unique code for the capability.
   */
  private bfrc(): string {
    const stringToHash = [
      this.title.trim() + this.authors.join(', ').trim() + (this.version?.toString() || '')
    ]
      .join('')
      .trim()
    const bufferHash = new SHA256().update(new SHA256().update(stringToHash).digest()).digest()
    const hash = bufferHash.toReversed()
    return Buffer.from(hash).toString('hex').substring(0, 12)
  }

  private isStringArray(
    value: string[] | undefined,
    maxItems: number,
    maxItemLength: number
  ): boolean {
    return (
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= maxItems &&
        value.every(
          item => typeof item === 'string' && item.trim().length > 0 && item.length <= maxItemLength
        ))
    )
  }

  private hasControlCharacter(value: string): boolean {
    for (const character of value) {
      const codePoint = character.codePointAt(0)
      if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
    }
    return false
  }
}
