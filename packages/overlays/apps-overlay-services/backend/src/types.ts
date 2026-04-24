import { OutpointString, PubKeyHex } from "@bsv/sdk"

export interface AppCatalogQuery {
  // Filter parameters
  domain?: string
  publisher?: PubKeyHex
  name?: string
  outpoint?: OutpointString
  tags?: string[]
  category?: string
  
  // Pagination parameters
  limit?: number    // Maximum number of results to return (default: 50)
  skip?: number     // Number of results to skip (default: 0)
  
  // Sorting parameters
  sortOrder?: 'asc' | 'desc'  // Sort direction (default: 'desc' - newest first)
}

/**
 * On-chain App metadata held inside the PushDrop token’s JSON payload.
 * Only the required fields are mandatory; the rest remain optional
 * exactly as in the proposal.
 */
export interface PublishedAppMetadata {
  version: '0.1.0'
  name: string
  description: string
  icon: string                            // URL or UHRP
  httpURL?: string
  uhrpURL?: string
  domain: string
  publisher: string                       // identity key
  short_name?: string
  category?: string
  tags?: string[]
  release_date: string                    // ISO-8601
  changelog?: string
  banner_image_url?: string
  screenshot_urls?: string[]
}

/**
 * A MongoDB document stored in the “appsCatalogRecords” collection.
 */
export interface AppCatalogRecord {
  txid: string
  outputIndex: number
  metadata: PublishedAppMetadata
  createdAt: Date
}