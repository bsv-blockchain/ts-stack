import { Hash } from '@bsv/sdk'

/**
 * Represents a capability in the BSV Paymail protocol.
 * A capability is essentially a feature or service offered by a Paymail provider.
 */
export default class Capability {
  /**
   * The unique code identifying the capability.
   */
  private readonly code?: string

  /**
   * The title of the capability.
   */
  private readonly title: string

  /**
   * The authors of the capability.
   */
  private readonly authors?: string[]

  /**
   * The version of the capability.
   */
  private readonly version?: string

  /**
   * Other capabilities that this one supersedes.
   */
  private readonly supersedes?: string[]

  /**
   * The HTTP method used by the capability (GET or POST).
   */
  private readonly method?: 'GET' | 'POST'

  /**
   * Constructs a new Capability instance.
   * @param params - The parameters for the capability.
   */
  constructor ({
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
    if (!title) throw new Error('Capability requires a title')
    this.code = code
    this.title = title
    this.authors = authors || []
    this.version = version
    this.supersedes = supersedes
    this.method = method
  }

  /**
   * Retrieves the code of the capability.
   * @returns The capability code or a generated code if not explicitly set.
   */
  public getCode (): string {
    return this.code || this.bfrc()
  }

  /**
   * Retrieves the HTTP method of the capability.
   * @returns The HTTP method ('GET' or 'POST').
   */
  public getMethod (): 'GET' | 'POST' {
    return this.method || 'GET'
  }

  /**
   * Generates a unique code based on the capability's properties.
   * This is used when an explicit code is not provided.
   * @returns A generated unique code for the capability.
   */
  private bfrc () {
    const stringToHash = [this.title.trim() + this.authors.join(', ').trim() + (this.version?.toString() || '')].join('').trim()
    const bufferHash = new Hash.SHA256().update(new Hash.SHA256().update(stringToHash).digest()).digest()
    const hash = bufferHash.reverse()
    return Buffer.from(hash).toString('hex').substring(0, 12)
  }
}
