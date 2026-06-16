import type {
  AdmittedListResponse,
  CompoundMerklePathResponse,
  RawTransactionResponse,
  TopicAnchorRangeResponse,
  TopicAnchorTip
} from './BASM.js'

export class BASMRemote {
  constructor(
    private readonly endpoint: string,
    private readonly topic: string,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis)
  ) { }

  async requestTopicAnchorTip(): Promise<TopicAnchorTip> {
    return await this.post<TopicAnchorTip>('/requestTopicAnchorTip', {})
  }

  async requestTopicAnchorRange(fromHeight: number, toHeight: number): Promise<TopicAnchorRangeResponse> {
    return await this.post<TopicAnchorRangeResponse>('/requestTopicAnchorRange', { fromHeight, toHeight })
  }

  async requestAdmittedList(blockHeight: number, blockHash?: string): Promise<AdmittedListResponse> {
    return await this.post<AdmittedListResponse>('/requestAdmittedList', { blockHeight, blockHash })
  }

  async requestCompoundMerklePath(blockHeight: number, txids: string[]): Promise<CompoundMerklePathResponse> {
    return await this.post<CompoundMerklePathResponse>('/requestCompoundMerklePath', { blockHeight, txids })
  }

  async requestRawTransactions(txids: string[]): Promise<RawTransactionResponse> {
    return await this.post<RawTransactionResponse>('/requestRawTransactions', { txids })
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.endpoint).toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-bsv-topic': this.topic
      },
      body: JSON.stringify(body)
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`BASM peer ${this.endpoint} returned ${response.status}: ${text}`)
    }

    return (text.length === 0 ? {} : JSON.parse(text)) as T
  }
}
