import { GASPInitialReply, GASPInitialRequest, GASPInitialResponse, GASPNode, GASPNodeResponse, GASPRemote } from '@bsv/gasp'
import {
  assertGASPInitialResponse,
  assertGASPNode,
  assertHash,
  assertNonnegativeInteger,
  assertOutpoint,
  assertOutputIndex,
  assertTopic,
  MAX_GASP_NODE_JSON_BYTES,
  MAX_GASP_PAGE_SIZE,
  readPeerJSON,
  securePeerFetch
} from '../RemoteSecurity.js'

export class OverlayGASPRemote implements GASPRemote {
  public readonly endpointURL: string
  public readonly topic: string
  private readonly fetchImpl: typeof fetch

  constructor (endpointURL: string, topic: string, fetchImpl?: typeof fetch) {
    assertTopic(topic)
    const secured = securePeerFetch(endpointURL, fetchImpl)
    this.endpointURL = secured.endpoint
    this.topic = topic
    this.fetchImpl = secured.fetchImpl
  }

  /**
   * Given an outgoing initial request, sends the request to the foreign instance and obtains their initial response.
   * @param request
   * @returns
   */
  async getInitialResponse (request: GASPInitialRequest): Promise<GASPInitialResponse> {
    assertNonnegativeInteger(request.since, 'GASP request since')
    const pageLimit = request.limit ?? MAX_GASP_PAGE_SIZE
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_GASP_PAGE_SIZE) {
      throw new TypeError(`GASP request limit must be between 1 and ${MAX_GASP_PAGE_SIZE}`)
    }
    const url = `${this.endpointURL}/requestSyncResponse`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BSV-Topic': this.topic
      },
      body: JSON.stringify(request)
    })

    const result = await readPeerJSON(response)
    assertGASPInitialResponse(result, pageLimit)
    return result
  }

  /**
   * Given an outgoing txid, outputIndex and optional metadata, request the associated GASP node from the foreign instance.
   * @param graphID
   * @param txid
   * @param outputIndex
   * @param metadata
   * @returns
   */
  async requestNode (graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> {
    assertOutpoint(graphID, 'GASP request graphID')
    assertHash(txid, 'GASP request txid')
    assertOutputIndex(outputIndex, 'GASP request outputIndex')
    if (typeof metadata !== 'boolean') throw new TypeError('GASP request metadata flag is invalid')
    const url = `${this.endpointURL}/requestForeignGASPNode`
    const body = {
      graphID,
      txid,
      outputIndex,
      metadata
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BSV-Topic': this.topic
      },
      body: JSON.stringify(body)
    })

    const result = await readPeerJSON(response, MAX_GASP_NODE_JSON_BYTES)
    assertGASPNode(result, { graphID, txid, outputIndex })
    return result
  }

  // ---- Now optional methods ----

  // When are only syncing to them
  async getInitialReply (_response: GASPInitialResponse): Promise<GASPInitialReply> {
    throw new Error('Function not supported!')
  }

  // Only used when supporting bidirectional sync.
  // Overlay services does not support this.
  async submitNode (_node: GASPNode): Promise<GASPNodeResponse | undefined> {
    throw new Error('Node submission not supported!')
  }
}
