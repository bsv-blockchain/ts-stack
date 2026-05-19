/**
 * Example HTTP Client for ChaintracksService
 *
 * This demonstrates how to call the ChaintracksService REST API endpoints
 * from a client application.
 */

interface ChaintracksResponse<T> {
  status: 'success' | 'error'
  value?: T
  code?: string
  description?: string
}

interface ChaintracksInfoApi {
  chain: string
  heightBulk: number
  heightLive: number
  storage: string
  bulkIngestors: string[]
  liveIngestors: string[]
  packages: Array<{ name: string; version: string }>
}

interface BlockHeader {
  version: number
  previousHash: string
  merkleRoot: string
  time: number
  bits: number
  nonce: number
  height: number
  hash: string
}

class ChaintracksClient {
  constructor(private baseUrl: string) {}

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    })

    const data: ChaintracksResponse<T> = await response.json() as ChaintracksResponse<T>

    if (data.status === 'error') {
      throw new Error(`API Error [${data.code}]: ${data.description}`)
    }

    return data.value as T
  }

  /**
   * Get the blockchain network (main or test)
   */
  async getChain(): Promise<string> {
    return this.request<string>('/getChain')
  }

  /**
   * Get service information and current state
   */
  async getInfo(): Promise<ChaintracksInfoApi> {
    return this.request<ChaintracksInfoApi>('/getInfo')
  }

  /**
   * Get the current blockchain height
   */
  async getPresentHeight(): Promise<number> {
    return this.request<number>('/getPresentHeight')
  }

  /**
   * Get the chain tip block hash
   */
  async findChainTipHash(): Promise<string> {
    return this.request<string>('/findChainTipHashHex')
  }

  /**
   * Get the chain tip block header
   */
  async findChainTipHeader(): Promise<BlockHeader> {
    return this.request<BlockHeader>('/findChainTipHeaderHex')
  }

  /**
   * Get block header for a specific height
   */
  async findHeaderForHeight(height: number): Promise<BlockHeader | undefined> {
    return this.request<BlockHeader | undefined>(`/findHeaderHexForHeight?height=${height}`)
  }

  /**
   * Get block header for a specific block hash
   */
  async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined> {
    return this.request<BlockHeader | undefined>(`/findHeaderHexForBlockHash?hash=${hash}`)
  }

  /**
   * Get multiple headers starting from a specific height
   */
  async getHeaders(height: number, count: number): Promise<string> {
    return this.request<string>(`/getHeaders?height=${height}&count=${count}`)
  }

  /**
   * Submit a new block header
   */
  async addHeader(header: {
    version: number
    previousHash: string
    merkleRoot: string
    time: number
    bits: number
    nonce: number
  }): Promise<void> {
    await this.request<void>('/addHeaderHex', {
      method: 'POST',
      body: JSON.stringify(header)
    })
  }
}

// Example usage
async function exampleUsage() {
  const client = new ChaintracksClient('http://localhost:3011')

  try {
    // Get service info
    console.log('Fetching service info...')
    const info = await client.getInfo()
    console.log('Service Info:', JSON.stringify(info, null, 2))

    // Get current height
    console.log('\nFetching current height...')
    const height = await client.getPresentHeight()
    console.log('Current Height:', height)

    // Get chain tip
    console.log('\nFetching chain tip...')
    const chainTip = await client.findChainTipHeader()
    console.log('Chain Tip:', JSON.stringify(chainTip, null, 2))

    // Get header for specific height
    console.log('\nFetching header for height 800000...')
    const header = await client.findHeaderForHeight(800000)
    if (header) {
      console.log('Header at 800000:', JSON.stringify(header, null, 2))
    } else {
      console.log('Header not found')
    }

    // Get multiple headers
    console.log('\nFetching 10 headers starting from height 800000...')
    const headersHex = await client.getHeaders(800000, 10)
    console.log('Headers (hex):', headersHex.substring(0, 100) + '...')
    console.log(`Total length: ${headersHex.length} chars (${headersHex.length / 2} bytes)`)
  } catch (error) {
    console.error('Error:', error)
  }
}

// Run example if this file is executed directly
if (require.main === module) {
  exampleUsage().catch(console.error)
}

export { ChaintracksClient, ChaintracksInfoApi, BlockHeader }
