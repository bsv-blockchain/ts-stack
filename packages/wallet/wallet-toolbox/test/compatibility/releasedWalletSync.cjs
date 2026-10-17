'use strict'
// Qualification controller, authored UNRUN. Its caller supplies two isolated,
// integrity-verified installations and owns their process/resource envelope.
// It installs nothing, publishes nothing and contacts only its loopback servers.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { once } = require('node:events')
const { tmpdir } = require('node:os')
const { performance } = require('node:perf_hooks')
const { createHash } = require('node:crypto')
const packages = Object.freeze(['@bsv/wallet-toolbox', '@bsv/wallet-toolbox-client', '@bsv/wallet-toolbox-mobile'])
const versions = Object.freeze({ released: '2.14.5', candidate: '2.15.0' })
const sdkVersions = Object.freeze({ 2: '2.8.11', 3: '3.2.1' })

/** Independent synthetic proof and public-row postimages. No production sync
 * exporter, native descriptor, journal hash or received row supplies an oracle. */
async function seedReplicaFamilies(install, source, target, identityKey, firstLabelId, when) {
  const { Transaction, Script, MerklePath } = install.sdk,
    tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'31'.repeat(131073)}`) })
  const rawTx = tx.toBinary(),
    txid = tx.id('hex'),
    merklePath = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]).toBinary(),
    header = Buffer.alloc(80),
    times = { created_at: when, updated_at: when },
    userId = source.user.userId,
    history = JSON.stringify({
      notes: [{ when: when.toISOString(), what: 'independent released compatibility', detail: '雪😀'.repeat(10000) }]
    }),
    description = 'independent compatibility 雪😀',
    script = tx.outputs[0].lockingScript.toBinary()
  header.writeInt32LE(1, 0)
  Buffer.from(txid, 'hex').reverse().copy(header, 36)
  header.writeUInt32LE(1, 68)
  const blockHash = createHash('sha256')
      .update(createHash('sha256').update(header).digest())
      .digest()
      .reverse()
      .toString('hex'),
    services = {
      getChainTracker: async () => ({ isValidRootForHeight: async (root, height) => root === txid && height === 100 }),
      getHeaderForHeight: async height => {
        assert.equal(height, 100)
        return [...header]
      }
    }
  source.storage.setServices(services)
  target.storage.setServices(services)
  const provenTxId = await source.storage.insertProvenTx({
      provenTxId: 0,
      ...times,
      txid,
      height: 100,
      index: 0,
      blockHash,
      merkleRoot: txid,
      rawTx,
      merklePath
    }),
    basketId = await source.storage.insertOutputBasket({
      basketId: 0,
      userId,
      ...times,
      name: 'compatibility-basket',
      isDeleted: false,
      numberOfDesiredUTXOs: 7,
      minimumDesiredUTXOValue: 11
    }),
    transactionId = await source.storage.insertTransaction({
      transactionId: 0,
      userId,
      ...times,
      provenTxId,
      txid,
      status: 'completed',
      reference: 'Y29tcGF0aWJpbGl0eQ==',
      isOutgoing: false,
      satoshis: 1,
      description,
      rawTx
    }),
    outputId = await source.storage.insertOutput({
      outputId: 0,
      userId,
      transactionId,
      basketId,
      ...times,
      txid,
      spendable: false,
      change: false,
      vout: 0,
      satoshis: 1,
      providedBy: 'you',
      purpose: 'compatibility',
      type: 'custom',
      outputDescription: 'compatibility output 雪',
      lockingScript: script
    }),
    outputTagId = await source.storage.insertOutputTag({
      outputTagId: 0,
      userId,
      ...times,
      tag: 'compatibility tag 雪',
      isDeleted: true
    }),
    certificateId = await source.storage.insertCertificate({
      certificateId: 0,
      userId,
      ...times,
      type: 'dHlwZQ==',
      serialNumber: 'c2VyaWFs',
      certifier: identityKey,
      subject: identityKey,
      revocationOutpoint: txid + '.0',
      signature: '00',
      isDeleted: true
    })
  await source.storage.insertTxLabelMap({ txLabelId: firstLabelId, transactionId, ...times, isDeleted: true })
  await source.storage.insertOutputTagMap({ outputTagId, outputId, ...times, isDeleted: true })
  await source.storage.insertCertificateField({
    userId,
    certificateId,
    ...times,
    fieldName: 'compatibility field 雪',
    fieldValue: 'independent value 😀',
    masterKey: 'independent master key'
  })
  await source.storage.insertCommission({
    commissionId: 0,
    userId,
    transactionId,
    ...times,
    satoshis: 1,
    keyOffset: 'independent offset 雪',
    isRedeemed: true,
    lockingScript: [81]
  })
  await source.storage.insertProvenTxReq({
    provenTxReqId: 0,
    ...times,
    provenTxId,
    txid,
    status: 'completed',
    attempts: 2,
    notified: true,
    history,
    notify: JSON.stringify({ transactionIds: [transactionId] }),
    rawTx
  })
  await source.storage.insertSyncState({
    syncStateId: 0,
    userId,
    ...times,
    storageIdentityKey: 'archived-compatibility-peer',
    storageName: 'archived fixture',
    status: 'unknown',
    init: true,
    refNum: 'archive-must-not-be-replica-cursor',
    syncMap: '{}'
  })
  const bytesEqual = (actual, expected) => assert.deepEqual(Buffer.from(actual), Buffer.from(expected)),
    one = rows => {
      assert.equal(rows.length, 1)
      return rows[0]
    },
    fields = (row, expected) => {
      for (const [name, value] of Object.entries(expected)) assert.deepEqual(row[name], value)
    }
  return async () => {
    const uid = target.user.userId,
      storage = target.storage,
      proof = one(await storage.findProvenTxs({ partial: { txid } })),
      basket = one(await storage.findOutputBaskets({ partial: { userId: uid, name: 'compatibility-basket' } })),
      action = one(await storage.findTransactions({ partial: { userId: uid, txid } })),
      output = one(
        await storage.findOutputs({ partial: { userId: uid, transactionId: action.transactionId, vout: 0 } })
      ),
      tag = one(await storage.findOutputTags({ partial: { userId: uid, tag: 'compatibility tag 雪' } })),
      label = one(await storage.findTxLabels({ partial: { userId: uid, label: 'compatibility-0' } })),
      certificate = one(
        await storage.findCertificates({ partial: { userId: uid, serialNumber: 'c2VyaWFs', certifier: identityKey } })
      ),
      field = one(
        await storage.findCertificateFields({
          partial: { userId: uid, certificateId: certificate.certificateId, fieldName: 'compatibility field 雪' }
        })
      ),
      commission = one(
        await storage.findCommissions({ partial: { userId: uid, transactionId: action.transactionId } })
      ),
      request = one(await storage.findProvenTxReqs({ partial: { txid } }))
    fields(proof, { txid, height: 100, index: 0, blockHash, merkleRoot: txid })
    bytesEqual(proof.rawTx, rawTx)
    bytesEqual(proof.merklePath, merklePath)
    fields(basket, { isDeleted: false, numberOfDesiredUTXOs: 7, minimumDesiredUTXOValue: 11 })
    fields(action, {
      status: 'completed',
      reference: 'Y29tcGF0aWJpbGl0eQ==',
      isOutgoing: false,
      satoshis: 1,
      description,
      provenTxId: proof.provenTxId
    })
    bytesEqual(action.rawTx, rawTx)
    fields(output, {
      basketId: basket.basketId,
      txid,
      spendable: false,
      change: false,
      satoshis: 1,
      providedBy: 'you',
      purpose: 'compatibility',
      type: 'custom',
      outputDescription: 'compatibility output 雪'
    })
    bytesEqual(output.lockingScript, script)
    fields(tag, { isDeleted: true })
    fields(
      one(
        await storage.findTxLabelMaps({ partial: { transactionId: action.transactionId, txLabelId: label.txLabelId } })
      ),
      { isDeleted: true }
    )
    fields(
      one(await storage.findOutputTagMaps({ partial: { outputId: output.outputId, outputTagId: tag.outputTagId } })),
      { isDeleted: true }
    )
    fields(certificate, {
      type: 'dHlwZQ==',
      subject: identityKey,
      revocationOutpoint: txid + '.0',
      signature: '00',
      isDeleted: true
    })
    fields(field, { fieldValue: 'independent value 😀', masterKey: 'independent master key' })
    fields(commission, { satoshis: 1, keyOffset: 'independent offset 雪', isRedeemed: true })
    bytesEqual(commission.lockingScript, [81])
    fields(request, { provenTxId: proof.provenTxId, status: 'completed', attempts: 2, notified: true })
    bytesEqual(request.rawTx, rawTx)
    assert.deepEqual(JSON.parse(request.history), JSON.parse(history))
    assert.deepEqual(JSON.parse(request.notify), { transactionIds: [action.transactionId] })
    assert.equal(
      (await storage.findSyncStates({ partial: { userId: uid, storageIdentityKey: 'archived-compatibility-peer' } }))
        .length,
      0,
      'Archived operational cursors must not become replica cursors'
    )
    for (const row of [proof, basket, action, output, tag, certificate, field, commission, request])
      assert.equal(row.created_at.getTime(), when.getTime())
  }
}

async function installation(root, version, sdkMajor) {
  assert.equal(typeof root, 'string')
  assert.ok(path.isAbsolute(root) && root.length <= 4096)
  root = await fs.realpath(root)
  const requireInstalled = createRequire(path.join(root, 'qualification.cjs'))
  const modules = [],
    directories = []
  for (const name of packages) {
    const directory = await fs.realpath(path.join(root, 'node_modules', name))
    assert.ok(
      directory.startsWith(root + path.sep),
      'Each cohort owns an isolated installation without workspace symlinks'
    )
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, name)
    assert.equal(manifest.version, version)
    const entry = requireInstalled.resolve(name)
    assert.ok(entry.startsWith(directory + path.sep), 'Resolve the actual installed artifact, never workspace aliases')
    modules.push(await import(pathToFileURL(entry).href))
    directories.push(directory)
  }
  const coreRequire = createRequire(path.join(directories[0], 'package.json'))
  const sdkDirectory = await fs.realpath(path.join(root, 'node_modules', '@bsv/sdk'))
  assert.ok(sdkDirectory.startsWith(root + path.sep))
  const sdkManifest = JSON.parse(await fs.readFile(path.join(sdkDirectory, 'package.json'), 'utf8'))
  assert.equal(sdkManifest.name, '@bsv/sdk')
  assert.equal(sdkManifest.version, sdkVersions[sdkMajor])
  for (const directory of directories)
    assert.ok(
      createRequire(path.join(directory, 'package.json'))
        .resolve('@bsv/sdk')
        .startsWith(sdkDirectory + path.sep),
      'Every actual packed consumer resolves the selected SDK cohort'
    )
  return {
    modules,
    directories,
    coreRequire,
    Server: coreRequire('./out/src/storage/remoting/StorageServer.js').StorageServer,
    sdk: coreRequire('@bsv/sdk'),
    knex: coreRequire('knex').knex
  }
}

async function runReleasedWalletSync(releasedRoot, candidateRoot, sdkMajor) {
  assert.ok(sdkMajor === 2 || sdkMajor === 3)
  const released = await installation(releasedRoot, versions.released, sdkMajor),
    candidate = await installation(candidateRoot, versions.candidate, sdkMajor),
    reports = []
  assert.notEqual(released.directories[0], candidate.directories[0])
  const { WalletStorageManager } = candidate.modules[0]
  const { PrivateKey, ProtoWallet } = candidate.sdk
  for (const [serverLine, serverInstall] of [
    ['released', released],
    ['candidate', candidate]
  ]) {
    for (const [clientLine, clientInstall] of [
      ['released', released],
      ['candidate', candidate]
    ]) {
      for (let index = 0; index < packages.length; index++) {
        for (const binaryRequests of [false, true]) {
          const directory = await fs.mkdtemp(path.join(tmpdir(), 'wallet-released-compatibility-'))
          await fs.chmod(directory, 0o700)
          const owners = [],
            began = performance.now()
          let server,
            listener,
            failed = false,
            failure,
            serverDrained = false
          try {
            const key = PrivateKey.fromRandom(),
              identityKey = key.toPublicKey().toString(),
              wallet = new ProtoWallet(key),
              serverKey = PrivateKey.fromRandom(),
              serverWallet = Object.assign(new ProtoWallet(serverKey), { chain: 'test' })
            const makeStorage = async (install, filename, storageIdentityKey) => {
              const { StorageKnex: Knex, StorageProvider: Provider } = install.modules[0]
              const database = install.knex({
                client: 'better-sqlite3',
                connection: { filename: path.join(directory, filename) },
                useNullAsDefault: true,
                pool: { min: 1, max: 1 },
                acquireConnectionTimeout: 1000
              })
              const storage = new Knex({
                ...Provider.createStorageBaseOptions('test'),
                knex: database,
                snapshotJournalRetention: false
              })
              owners.push({ storage, database })
              await database.raw('PRAGMA journal_mode = WAL')
              await storage.migrate('Released compatibility fixture', storageIdentityKey)
              await storage.makeAvailable()
              const { user } = await storage.findOrInsertUser(identityKey)
              await storage.updateUser(user.userId, { activeStorage: 'compatibility-source' })
              return { storage, user }
            }
            const source = await makeStorage(candidate, 'source.sqlite', 'compatibility-source'),
              target = await makeStorage(serverInstall, 'target.sqlite', 'compatibility-target'),
              when = new Date('2026-10-08T00:00:00.000Z')
            let firstLabelId
            for (let row = 0; row < 130; row++) {
              const id = await source.storage.insertTxLabel({
                txLabelId: 0,
                userId: source.user.userId,
                created_at: when,
                updated_at: when,
                label: `compatibility-${row}`,
                isDeleted: row % 3 === 0
              })
              if (row === 0) firstLabelId = id
            }
            const inspectFamilies = await seedReplicaFamilies(
              candidate,
              source,
              target,
              identityKey,
              firstLabelId,
              when
            )
            // An independent identity must not appear in this authenticated copy.
            const { user: other } = await source.storage.findOrInsertUser(
              PrivateKey.fromRandom().toPublicKey().toString()
            )
            await source.storage.insertTxLabel({
              txLabelId: 0,
              userId: other.userId,
              created_at: when,
              updated_at: when,
              label: 'other-profile',
              isDeleted: false
            })
            server = new serverInstall.Server(target.storage, {
              port: 0,
              host: '127.0.0.1',
              wallet: serverWallet,
              monetize: false,
              logRpcRequests: false
            })
            server.start()
            listener = server.server
            if (!listener.listening) await once(listener, 'listening')
            let binaryRequestCount = 0,
              requestCount = 0,
              requestFault
            listener.on('request', request => {
              if (requestCount >= 10000) {
                requestFault ??= new Error('Released compatibility exceeded its original finite request bound')
                return
              }
              requestCount++
              if (request.headers['x-bsv-binary-request-encoding'] === 'base64') binaryRequestCount++
            })
            const address = listener.address()
            assert.ok(address && typeof address !== 'string')
            const Client = clientInstall.modules[index].StorageClient
            assert.equal(typeof Client, 'function')
            const client = new Client(wallet, `http://127.0.0.1:${address.port}`, {
                serverIdentityKey: serverKey.toPublicKey().toString(),
                binaryRequests
              }),
              manager = new WalletStorageManager(identityKey, source.storage)
            await manager.makeAvailable()
            const counts = await manager.syncToWriter(await manager.getAuth(), client)
            assert.ok(counts.inserts >= 130)
            const expected = Array.from({ length: 130 }, (_, row) => ({
              label: `compatibility-${row}`,
              isDeleted: row % 3 === 0
            })).sort((a, b) => a.label.localeCompare(b.label))
            const inspect = async () => {
              const rows = await target.storage.findTxLabels({ partial: { userId: target.user.userId } })
              assert.deepEqual(
                rows
                  .map(row => ({ label: row.label, isDeleted: row.isDeleted }))
                  .sort((a, b) => a.label.localeCompare(b.label)),
                expected
              )
            }
            await inspect()
            await inspectFamilies()
            // Unchanged copy must preserve the actual rows and not duplicate maps.
            const unchanged = await manager.syncToWriter(await manager.getAuth(), client)
            assert.equal(unchanged.inserts, 0)
            assert.equal(unchanged.updates, 0)
            await inspect()
            await inspectFamilies()
            if (requestFault !== undefined) throw requestFault
            assert.ok(requestCount > 0)
            assert.equal(binaryRequests ? binaryRequestCount > 0 : binaryRequestCount === 0, true)
            reports.push({
              sdkMajor,
              sdkVersion: sdkVersions[sdkMajor],
              serverLine,
              clientLine,
              clientPackage: packages[index],
              rows: 130,
              requestEncoding: binaryRequests ? 'compact-base64' : 'numeric-json',
              binaryRequestCount,
              requestCount,
              replicaFamilies: 12,
              largeRawTransaction: true,
              largeHistory: true,
              syntheticProofHeaderValidated: true,
              archivedCursorAbsent: true,
              authenticated: true,
              otherProfileAbsent: true,
              unchanged: true,
              wallMs: performance.now() - began
            })
          } catch (cause) {
            failed = true
            failure = cause
          }
          // Join actual original operations before closing their physical owners.
          const cleanup = []
          try {
            await server?.close()
            serverDrained = true
          } catch (cause) {
            cleanup.push(cause)
          }
          if (listener?.listening)
            try {
              await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())))
            } catch (cause) {
              cleanup.push(cause)
            }
          let drained = serverDrained && !listener?.listening
          for (const owner of owners.reverse()) {
            try {
              await owner.storage.destroy()
            } catch (cause) {
              cleanup.push(cause)
            }
            try {
              await owner.database.destroy()
            } catch (cause) {
              drained = false
              cleanup.push(cause)
            }
          }
          if (drained)
            try {
              await fs.rm(directory, { recursive: true, force: true })
            } catch (cause) {
              cleanup.push(cause)
            }
          if (cleanup.length !== 0)
            throw new AggregateError(
              failed ? [failure, ...cleanup] : cleanup,
              'Released compatibility retains original cleanup owners'
            )
          if (failed) throw failure
        }
      }
    }
  }
  assert.equal(reports.length, 24)
  return {
    versions,
    sdkMajor,
    sdkVersion: sdkVersions[sdkMajor],
    reports,
    physicalDeviceQualified: false,
    processTreeQualified: false
  }
}

async function runWalletSyncCompatibilityCohorts(cohorts) {
  assert.ok(cohorts !== null && typeof cohorts === 'object' && !Array.isArray(cohorts))
  const names = ['releasedSdk2', 'candidateSdk2', 'releasedSdk3', 'candidateSdk3']
  assert.deepEqual(
    Object.keys(cohorts).sort((a, b) => Number(a > b) - Number(a < b)),
    [...names].sort((a, b) => Number(a > b) - Number(a < b))
  )
  const roots = await Promise.all(names.map(name => fs.realpath(cohorts[name])))
  assert.equal(new Set(roots).size, 4, 'Four independent installations are required for the complete SDK2/SDK3 matrix')
  const reports = []
  for (const major of [2, 3])
    reports.push(await runReleasedWalletSync(cohorts[`releasedSdk${major}`], cohorts[`candidateSdk${major}`], major))
  assert.equal(
    reports.reduce((count, report) => count + report.reports.length, 0),
    48
  )
  return { versions, sdkVersions, cohorts: reports, physicalDeviceQualified: false, processTreeQualified: false }
}

async function readWalletSyncCohorts(filename) {
  const file = await fs.open(filename, 'r')
  let cohorts
  try {
    const stat = await file.stat({ bigint: true })
    assert.ok(stat.isFile() && stat.size >= 2n && stat.size <= 32768n)
    const bytes = Buffer.alloc(Number(stat.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await file.stat({ bigint: true })
    assert.equal(length, Number(stat.size))
    assert.equal(after.size, stat.size)
    assert.equal(after.mtimeNs, stat.mtimeNs)
    cohorts = JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    await file.close()
  }
  return cohorts
}

module.exports = {
  runReleasedWalletSync,
  runWalletSyncCompatibilityCohorts,
  readWalletSyncCohorts,
  packages,
  versions,
  sdkVersions
}

if (require.main === module) {
  const args = process.argv.slice(2)
  Promise.resolve()
    .then(async () => {
      assert.equal(args.length, 2, 'Usage: releasedWalletSync.cjs --cohorts /absolute/cohorts.json')
      assert.equal(args[0], '--cohorts')
      assert.ok(path.isAbsolute(args[1]))
      const cohorts = await readWalletSyncCohorts(args[1])
      process.stdout.write(JSON.stringify(await runWalletSyncCompatibilityCohorts(cohorts)) + '\n')
    })
    .catch(cause => {
      process.stderr.write(String(cause?.stack ?? cause) + '\n')
      process.exitCode = 1
    })
}
