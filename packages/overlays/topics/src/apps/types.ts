import { OutpointString, PubKeyHex } from '@bsv/sdk'

export interface AppCatalogQuery {
  domain?: string
  publisher?: PubKeyHex
  name?: string
  outpoint?: OutpointString
  tags?: string[]
  category?: string
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

export interface PublishedAppMetadata {
  version: '0.1.0'
  name: string
  description: string
  icon: string
  httpURL?: string
  uhrpURL?: string
  domain: string
  publisher: string
  short_name?: string
  category?: string
  tags?: string[]
  release_date: string
  changelog?: string
  banner_image_url?: string
  screenshot_urls?: string[]
}

export interface AppCatalogRecord {
  txid: string
  outputIndex: number
  metadata: PublishedAppMetadata
  createdAt: Date
}
