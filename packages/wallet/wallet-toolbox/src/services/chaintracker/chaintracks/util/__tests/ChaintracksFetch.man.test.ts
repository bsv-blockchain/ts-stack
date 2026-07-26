import { Hash } from '@bsv/sdk'
import { asArray, asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { BulkHeaderFilesInfo } from '../BulkHeaderFile'
import { ChaintracksFetch } from '../ChaintracksFetch'
import { validBulkHeaderFilesByFileHash } from '../validBulkHeaderFilesByFileHash'

describe('ChaintracksFetch live CDN tests', () => {
  jest.setTimeout(99999999)

  test('fetches the testnet header index', async () => {
    const fetch = new ChaintracksFetch()
    const info = await fetch.fetchJson<BulkHeaderFilesInfo>(
      'https://cdn.projectbabbage.com/blockheaders/testNetBlockHeaders.json'
    )
    expect(info.files.length).toBeGreaterThan(4)
  })

  test.each(['testNet_0.headers', 'testNet_4.headers', 'mainNet_2.headers'])(
    'downloads and validates %s',
    async fileName => {
      const fetch = new ChaintracksFetch()
      const data = await fetch.download(`https://cdn.projectbabbage.com/blockheaders/${fileName}`)
      expect(data).toHaveLength(80 * 100000)
      const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
      expect(validBulkHeaderFilesByFileHash()[fileHash]).toBeDefined()
    }
  )
})
