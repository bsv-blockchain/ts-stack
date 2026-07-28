import type { Knex } from 'knex'

import type { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { Chaintracks } from '../Chaintracks'
import {
  createAndStartDefaultChaintracks,
  createDefaultChaintracksStorageOptions,
  resolveDefaultChaintracksArguments,
  startChaintracks,
  toDefaultChaintracksArguments
} from '../configureChaintracksIngestors'
import {
  createAndStartDefaultKnexChaintracks,
  resolveDefaultKnexChaintracksArguments,
  toDefaultKnexChaintracksArguments
} from '../configureKnexChaintracks'
import { createDefaultIdbChaintracksOptions } from '../createDefaultIdbChaintracksOptions'
import { createDefaultKnexChaintracksOptions } from '../createDefaultKnexChaintracksOptions'
import { createDefaultNoDbChaintracksOptions } from '../createDefaultNoDbChaintracksOptions'
import { createIdbChaintracks } from '../createIdbChaintracks'
import { createKnexChaintracks } from '../createKnexChaintracks'
import { createNoDbChaintracks } from '../createNoDbChaintracks'
import { ChaintracksStorageIdb } from '../Storage/ChaintracksStorageIdb'
import { ChaintracksStorageKnex } from '../Storage/ChaintracksStorageKnex'
import { ChaintracksStorageNoDb } from '../Storage/ChaintracksStorageNoDb'

const fetchApi = {
  httpClient: {},
  download: jest.fn(),
  fetchJson: jest.fn(),
  pathJoin: (baseUrl: string, subpath: string) => `${baseUrl}${subpath}`
} as unknown as ChaintracksFetchApi

const customTail = ['api-key', 50, 7, fetchApi, 'https://cdn.example/', 25, 8, 12, 13, 14] as const

describe('Chaintracks configuration compatibility', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('resolves stable defaults and preserves custom positional arguments', () => {
    const defaults = resolveDefaultChaintracksArguments(['main'])
    expect(defaults).toMatchObject({
      chain: 'main',
      whatsonchainApiKey: '',
      maxPerFile: 100000,
      maxRetained: 2,
      cdnUrl: 'https://cdn.projectbabbage.com/blockheaders/',
      liveHeightThreshold: 2000,
      reorgHeightThreshold: 400,
      bulkMigrationChunkSize: 500,
      batchInsertLimit: 400,
      addLiveRecursionLimit: 36
    })
    expect(defaults.fetch).toEqual(
      expect.objectContaining({
        download: expect.any(Function),
        fetchJson: expect.any(Function),
        pathJoin: expect.any(Function)
      })
    )

    const custom = resolveDefaultChaintracksArguments(['test', ...customTail])
    expect(toDefaultChaintracksArguments(custom)).toEqual(['test', ...customTail])

    const storageOptions = createDefaultChaintracksStorageOptions(custom)
    expect(storageOptions).toMatchObject({
      chain: 'test',
      liveHeightThreshold: 25,
      reorgHeightThreshold: 8,
      bulkMigrationChunkSize: 12,
      batchInsertLimit: 13
    })
    expect(storageOptions.bulkFileDataManager).toMatchObject({
      chain: 'test',
      maxPerFile: 50,
      maxRetained: 7,
      fetch: fetchApi,
      fromKnownSourceUrl: 'https://cdn.example/'
    })
  })

  test('preserves Knex-specific arguments around the shared positional tail', () => {
    const knexConfig: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }
    const defaults = resolveDefaultKnexChaintracksArguments(['main'])
    expect(defaults).toMatchObject({ chain: 'main', rootFolder: './data/' })
    expect(defaults.knexConfig).toBeUndefined()

    const custom = resolveDefaultKnexChaintracksArguments(['test', '/tmp/chaintracks/', knexConfig, ...customTail])
    expect(toDefaultKnexChaintracksArguments(custom)).toEqual(['test', '/tmp/chaintracks/', knexConfig, ...customTail])
  })

  test('builds each storage backend without starting network ingestion', async () => {
    const noDb = createDefaultNoDbChaintracksOptions('main', ...customTail)
    const idb = createDefaultIdbChaintracksOptions('test', ...customTail)
    const knexOptions = createDefaultKnexChaintracksOptions(
      'main',
      './unused/',
      {
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
      },
      ...customTail
    )

    expect(noDb.storage).toBeInstanceOf(ChaintracksStorageNoDb)
    expect(idb.storage).toBeInstanceOf(ChaintracksStorageIdb)
    expect(knexOptions.storage).toBeInstanceOf(ChaintracksStorageKnex)
    expect(noDb).toMatchObject({ chain: 'main', addLiveRecursionLimit: 14 })
    expect(idb).toMatchObject({ chain: 'test', addLiveRecursionLimit: 14 })
    expect(knexOptions).toMatchObject({ chain: 'main', addLiveRecursionLimit: 14 })

    const defaultKnexOptions = createDefaultKnexChaintracksOptions('main')
    await (knexOptions.storage as ChaintracksStorageKnex).shutdown()
    await (defaultKnexOptions.storage as ChaintracksStorageKnex).shutdown()
  })

  test('starts shared and Knex configurations with exact resolved metadata', async () => {
    const available = Promise.resolve()
    const makeAvailable = jest.spyOn(Chaintracks.prototype, 'makeAvailable').mockReturnValue(available)
    const noDbOptions = createDefaultNoDbChaintracksOptions('main', ...customTail)
    const params = resolveDefaultChaintracksArguments(['main', ...customTail])

    const started = startChaintracks<ChaintracksStorageNoDb>(params, noDbOptions)
    expect(started).toMatchObject({
      chain: 'main',
      maxPerFile: 50,
      fetch: fetchApi,
      storage: noDbOptions.storage,
      available
    })

    const created = createAndStartDefaultChaintracks<ChaintracksStorageNoDb>(
      ['main', ...customTail],
      createDefaultNoDbChaintracksOptions
    )
    expect(created.storage).toBeInstanceOf(ChaintracksStorageNoDb)

    const knexConfig: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }
    const knex = createAndStartDefaultKnexChaintracks<ChaintracksStorageKnex>(
      ['main', './unused/', knexConfig, ...customTail],
      createDefaultKnexChaintracksOptions
    )
    expect(knex.storage).toBeInstanceOf(ChaintracksStorageKnex)
    expect(makeAvailable).toHaveBeenCalledTimes(3)

    await knex.storage.shutdown()
  })

  test('public storage factories expose startup and preserve their error context', async () => {
    const available = Promise.resolve()
    jest.spyOn(Chaintracks.prototype, 'makeAvailable').mockReturnValue(available)

    const noDb = await createNoDbChaintracks('main', ...customTail)
    const idb = await createIdbChaintracks('test', ...customTail)
    const knex = await createKnexChaintracks(
      'main',
      './unused/',
      {
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
      },
      ...customTail
    )

    expect(noDb.available).toBe(available)
    expect(idb.available).toBe(available)
    expect(knex.available).toBe(available)
    await knex.storage.shutdown()

    const failure = new Error('startup failed')
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(Chaintracks.prototype, 'makeAvailable').mockImplementation(() => {
      throw failure
    })

    await expect(createNoDbChaintracks('main', ...customTail)).rejects.toBe(failure)
    await expect(createIdbChaintracks('test', ...customTail)).rejects.toBe(failure)
    await expect(
      createKnexChaintracks(
        'main',
        './unused/',
        {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true
        },
        ...customTail
      )
    ).rejects.toBe(failure)
  })
})
