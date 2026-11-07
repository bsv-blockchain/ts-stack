import { MongoClient } from 'mongodb'
import type { Engine } from '@bsv/overlay'
import {
  canonicalOutputJSON,
  outputAssert,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { bootstrapMongoOverlay } from '@bsv/overlay/storage/mongo/MongoSchema'
import { fixtureChain } from './fixtureChain.js'
import {
  createReferenceAdmissionProducer,
  createReferenceEngine
} from './referenceAdmissionProducer.js'
import type { ReferenceProducerFactory } from './referenceProvider.js'

/** Explicit isolated loopback database; recovery never creates its ownership marker. */
export async function openReferenceMongo(options: {
  uri: string
  database: string
  identity: string
  role: string
  create: boolean
}): Promise<{ engine: Engine; producer: ReferenceProducerFactory; close(): Promise<void> }> {
  outputAssert(options.uri.length <= 2048, 'Invalid reference Mongo endpoint')
  let uri: URL
  try {
    uri = new URL(options.uri)
  } catch {
    throw new OutputProtocolError('invalid', 'Invalid reference Mongo endpoint')
  }
  outputAssert(
    uri.protocol === 'mongodb:' &&
      ['127.0.0.1', '[::1]'].includes(uri.hostname) &&
      uri.username === '' &&
      uri.password === '',
    'Reference Mongo must use an isolated loopback replica set'
  )
  outputAssert(
    /^output_reference_\w{1,48}$/.test(options.database),
    'Reference database must use the output_reference_ prefix'
  )
  outputAssert(['one', 'two'].includes(options.role), 'Invalid reference Mongo role')
  const client = new MongoClient(options.uri, {
    appName: 'output-knowledge-reference',
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 5000,
    maxPoolSize: 8,
    writeConcern: { w: 'majority', j: true }
  })
  let storage: MongoOverlayStorage | undefined
  try {
    await client.connect()
    const db = client.db(options.database)
    const scope = { ...fixtureChain, nodeId: 'reference-' + options.role + '-' + options.identity }
    const marker = { format: 'output-reference-mongo/1', identity: options.identity, scope }
    const owners = db.collection<{ _id: string; descriptor: OutputJSONObject }>(
      'reference_workbench_owners'
    )
    if (options.create)
      await owners.updateOne(
        { _id: scope.nodeId },
        { $setOnInsert: { descriptor: marker } },
        { upsert: true }
      )
    const saved = await owners.findOne({ _id: scope.nodeId })
    if (!saved)
      throw new OutputProtocolError('reset-required', 'Reference admission custody is missing')
    outputAssert(
      canonicalOutputJSON(saved.descriptor) === canonicalOutputJSON(marker),
      'Reference Mongo ownership differs',
      'context-changed'
    )
    if (options.create) await bootstrapMongoOverlay(db, scope)
    storage = new MongoOverlayStorage(db, scope, { retainAdmissionHistory: true })
    const installed = storage
    const engine = await createReferenceEngine(installed)
    return {
      engine,
      producer: context =>
        createReferenceAdmissionProducer(context, { engine, storage: installed }),
      async close() {
        try {
          await installed.close()
        } finally {
          await client.close()
        }
      }
    }
  } catch (error) {
    try {
      await storage?.close()
    } finally {
      await client.close()
    }
    throw error
  }
}
