#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createCommandRunner } from './lib/command-runner.mjs'

const run = createCommandRunner({ timeoutMs: 180_000, maxBufferBytes: 20 * 1024 * 1024 })
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Executed in isolated consumers, so every class comes from the installed tarballs.
async function exercise(sdk, templates, check) {
  const { Hash, LockingScript, OP, PrivateKey, ProtoWallet, PublicKey, Spend, Transaction } = sdk
  const { MandalaAdmin, MandalaToken, MultiPushDrop, OpReturn, P2MSKH, R1K1Wallet } = templates
  const privateKey = new PrivateKey(23)
  const wallet = new ProtoWallet(privateKey)
  const publicKeyHash = Hash.hash160(privateKey.toPublicKey().encode(true))
  const digest = script => Buffer.from(Hash.sha256(script.toBinary())).toString('hex')
  const results = {}

  async function spend(name, lockingScript, unlocker) {
    check.ok(lockingScript instanceof LockingScript)
    const source = new Transaction()
    source.addOutput({ lockingScript, satoshis: 1 })
    const transaction = new Transaction()
    transaction.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff })
    transaction.addOutput({ lockingScript: new LockingScript([{ op: OP.OP_TRUE }]), satoshis: 1 })
    const unlockingScript = await unlocker.sign(transaction, 0)
    check.equal(
      new Spend({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        lockingScript,
        transactionVersion: transaction.version,
        otherInputs: [],
        inputIndex: 0,
        unlockingScript,
        outputs: transaction.outputs,
        inputSequence: 0xffffffff,
        lockTime: transaction.lockTime
      }).validate(),
      true,
      `${name} signature must execute against its source contract`
    )
    results[name] = digest(lockingScript)
  }

  const assetId = `${'ab'.repeat(32)}.0`
  const token = new MandalaToken()
  await spend('MandalaToken', token.lock(assetId, 1, publicKeyHash), token.unlock(privateKey))
  check.throws(() => token.lock(assetId, 0, publicKeyHash), /positive/)
  const adminData = { kind: 'issue', assetId, amount: 1 }
  await spend(
    'MandalaAdmin',
    await MandalaAdmin.lock({ wallet, data: adminData }),
    MandalaAdmin.unlock({ wallet, data: adminData })
  )
  const pushDrop = new MultiPushDrop(wallet)
  const protocolID = [1, 'packed template consumer']
  await spend(
    'MultiPushDrop',
    await pushDrop.lock([[1, 2, 3]], protocolID, 'fixture', ['self']),
    pushDrop.unlock(protocolID, 'fixture', 'self')
  )
  const counterparty = privateKey.toPublicKey().toString()
  const { publicKey } = await wallet.getPublicKey({
    protocolID: [1, 'multi sig brc29'],
    keyID: 'fixture',
    counterparty,
    forSelf: true
  })
  const pubkeys = [publicKey, new PrivateKey(29).toPublicKey().toString()]
  const multisig = new P2MSKH()
  await spend(
    'P2MSKH',
    multisig.lock(
      undefined,
      pubkeys.map(key => PublicKey.fromString(key)),
      1
    ),
    multisig.unlock(wallet, { pubkeys, keyID: 'fixture', counterparty })
  )
  const recovery = new R1K1Wallet()
  await spend(
    'R1K1Wallet',
    await recovery.lock(Array(20).fill(7), publicKeyHash),
    recovery.unlock({ path: 'k1', privateKey })
  )
  const opReturn = new OpReturn().lock(['packed', 'consumer'])
  check.deepEqual(OpReturn.decode(opReturn), ['packed', 'consumer'])
  results.OpReturn = digest(opReturn)
  return results
}

async function pack(directory, destination) {
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })
  return path.resolve(JSON.parse(stdout).filename)
}

function consumerSource(format) {
  const imports =
    format === 'cjs'
      ? `const sdk = require('@bsv/sdk')
const templates = require('@bsv/templates')
const { MandalaToken } = require('@bsv/templates/MandalaToken.ts')
const check = require('node:assert/strict')`
      : `import * as sdk from '@bsv/sdk'
import * as templates from '@bsv/templates'
import { MandalaToken } from '@bsv/templates/MandalaToken.ts'
import check from 'node:assert/strict'`
  return `${imports}
check.equal(MandalaToken, templates.MandalaToken)
;(${exercise.toString()})(sdk, templates, check).then(result => console.log(JSON.stringify(result)))
`
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'template-consumers-'))
try {
  const templates = await pack(path.join(root, 'packages/helpers/ts-templates'), temporary)
  const candidate = await pack(path.join(root, 'packages/sdk'), temporary)
  const sdkManifest = JSON.parse(
    await fs.readFile(path.join(root, 'packages/sdk/package.json'), 'utf8')
  )
  const profiles = [
    { label: 'candidate', sdk: candidate, version: sdkManifest.version },
    {
      label: 'published',
      sdk: process.env.TEMPLATES_PUBLISHED_SDK_TARBALL ?? '@bsv/sdk@2.8.0',
      version: '2.8.0'
    }
  ]
  const results = []
  for (const profile of profiles) {
    const cwd = path.join(temporary, profile.label)
    await fs.mkdir(cwd)
    await fs.writeFile(path.join(cwd, 'package.json'), '{"private":true,"type":"module"}\n')
    await run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--omit=dev',
        templates,
        profile.sdk
      ],
      { cwd }
    )
    const installed = JSON.parse(
      await fs.readFile(path.join(cwd, 'node_modules/@bsv/sdk/package.json'), 'utf8')
    )
    assert.equal(installed.version, profile.version)
    for (const format of ['cjs', 'mjs']) {
      const filename = `consumer.${format}`
      await fs.writeFile(path.join(cwd, filename), consumerSource(format))
      const { stdout } = await run(process.execPath, [filename], { cwd })
      results.push(JSON.parse(stdout))
      console.log(
        `Verified packed templates script construction and signing: SDK ${profile.version}, ${format}.`
      )
    }
  }
  for (const result of results.slice(1)) assert.deepEqual(result, results[0])
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
