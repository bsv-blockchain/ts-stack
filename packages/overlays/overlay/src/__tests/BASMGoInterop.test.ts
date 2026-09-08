import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MerklePath, Transaction } from '@bsv/sdk'
import { BASMRemote } from '../BASMRemote'
import { computeBasmRoot, computeTac, BASM_ZERO_HASH } from '../BASM'

const TOPIC = 'tm_interop'
const GENESIS_TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const GENESIS_HEX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'
const GENESIS_BLOCK = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const MISSING = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const GO_SOURCE = join(__dirname, 'fixtures', 'basm-go-read-server.go')

function displayToInternal(hash: string): Buffer {
  return Buffer.from(hash, 'hex').reverse()
}

function independentTac(previous: string, blockHash: string, root: string): string {
  const input = Buffer.concat([
    displayToInternal(previous),
    displayToInternal(blockHash),
    displayToInternal(root)
  ])
  const first = createHash('sha256').update(input).digest()
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex')
}

function resolveGoWorktree(): string | undefined {
  const candidates = [
    process.env.BASM_GO_OVERLAY_SERVICES,
    '/Users/personal/git/go/worktrees/go-overlay-services-basm'
  ]
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      existsSync(join(candidate, 'pkg/server/server_http_basm_interop_test.go')) &&
      existsSync(join(candidate, 'pkg/core/engine/basm-read-service.go'))
    ) {
      return candidate
    }
  }
  return undefined
}

async function waitForUrls(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ ready: string; unsupported: string }> {
  let stdout = ''
  let stderr = ''
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, urls?: { ready: string; unsupported: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error !== undefined) reject(error)
      else resolve(urls as { ready: string; unsupported: string })
    }
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Go BASM host did not become ready: stdout=${stdout.trim()} stderr=${stderr.trim()}`
        )
      )
    }, timeoutMs)
    const onStdout = (chunk: Buffer | string): void => {
      stdout += String(chunk)
      const ready = stdout.match(/^READY (http:\/\/127\.0\.0\.1:\d+)/m)?.[1]
      const unsupported = stdout.match(/^UNSUPPORTED (http:\/\/127\.0\.0\.1:\d+)/m)?.[1]
      if (ready !== undefined && unsupported !== undefined) {
        finish(undefined, { ready, unsupported })
      }
    }
    const onStderr = (chunk: Buffer | string): void => {
      stderr += String(chunk)
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(
          `Go BASM host exited code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`
        )
      )
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function startGoHost(goRoot: string): ChildProcessWithoutNullStreams {
  const dir = mkdtempSync(join(tmpdir(), 'basm-go-interop-'))
  copyFileSync(GO_SOURCE, join(dir, 'main.go'))
  writeFileSync(
    join(dir, 'go.mod'),
    [
      'module ts-basm-go-interop',
      '',
      'go 1.26.0',
      '',
      'require github.com/bsv-blockchain/go-overlay-services v0.0.0',
      '',
      `replace github.com/bsv-blockchain/go-overlay-services => ${goRoot}`,
      ''
    ].join('\n')
  )
  const env = { ...process.env, GOTOOLCHAIN: 'local' }
  const tidy = spawnSync('go', ['mod', 'tidy'], { cwd: dir, encoding: 'utf8', env })
  if (tidy.status !== 0) {
    throw new Error(`go mod tidy failed: ${tidy.stderr || tidy.stdout}`)
  }
  const build = spawnSync('go', ['build', '-o', 'basm-host', '.'], {
    cwd: dir,
    encoding: 'utf8',
    env
  })
  if (build.status !== 0) {
    throw new Error(`go build failed: ${build.stderr || build.stdout}`)
  }
  const child = spawn(join(dir, 'basm-host'), [], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.unref()
  return child
}

const goRoot = resolveGoWorktree()
const describeInterop = goRoot === undefined ? describe.skip : describe

describeInterop('BASMRemote localhost interop against Go read/serving', () => {
  let child: ChildProcessWithoutNullStreams
  let readyURL = ''
  let unsupportedURL = ''

  beforeAll(async () => {
    child = startGoHost(goRoot as string)
    const urls = await waitForUrls(child, 120000)
    readyURL = urls.ready
    unsupportedURL = urls.unsupported
  }, 130000)

  afterAll(() => {
    child?.kill('SIGTERM')
  })

  it('exchanges the five BRC-136 read methods over credential-free HTTP', async () => {
    const remote = new BASMRemote(readyURL, TOPIC)
    const tip = await remote.requestTopicAnchorTip()
    const range = await remote.requestTopicAnchorRange(0, 0)
    const admitted = await remote.requestAdmittedList(0, GENESIS_BLOCK)
    const proof = await remote.requestCompoundMerklePath(0, [GENESIS_TXID])
    const raw = await remote.requestRawTransactions([GENESIS_TXID, MISSING])

    expect(tip.topic).toBe(TOPIC)
    expect(tip.blockHeight).toBe(0)
    expect(tip.blockHash).toBe(GENESIS_BLOCK)
    expect(tip.basmRoot).toBe(GENESIS_TXID)
    expect(tip.admittedCount).toBe(1)
    expect(computeBasmRoot([{ txid: GENESIS_TXID, blockIndex: 0 }])).toBe(GENESIS_TXID)
    expect(independentTac(BASM_ZERO_HASH, GENESIS_BLOCK, GENESIS_TXID)).toBe(tip.tac)
    expect(computeTac(BASM_ZERO_HASH, GENESIS_BLOCK, GENESIS_TXID)).toBe(tip.tac)

    expect(range.anchors).toHaveLength(1)
    expect(range.anchors[0]?.tac).toBe(tip.tac)
    expect(range.anchors[0]?.blockHash).toBe(GENESIS_BLOCK)
    expect(admitted.admitted).toEqual([{ txid: GENESIS_TXID, blockIndex: 0 }])

    const parsedProof = MerklePath.fromHex(proof.merklePath)
    expect(parsedProof.blockHeight).toBe(0)
    expect(parsedProof.path[0]?.[0]?.hash).toBe(GENESIS_TXID)
    expect(parsedProof.path[0]?.[0]?.offset).toBe(0)
    expect(parsedProof.computeRoot(GENESIS_TXID)).toBe(GENESIS_TXID)
    expect(parsedProof.toHex()).toBe(proof.merklePath.toLowerCase())

    const parsedRaw = Transaction.fromHex(raw.transactions[0].rawTx)
    expect(raw.transactions[0].txid).toBe(GENESIS_TXID)
    expect(raw.transactions[0].rawTx).toBe(GENESIS_HEX)
    expect(parsedRaw.id('hex')).toBe(GENESIS_TXID)
    expect(raw.missing).toEqual([MISSING])

    const cors = await fetch(new URL('/requestTopicAnchorTip', readyURL), {
      method: 'POST',
      headers: {
        Origin: 'https://unknown-wallet.example',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-bsv-topic': TOPIC
      },
      body: '{}'
    })
    expect(cors.ok).toBe(true)
    expect(cors.headers.get('access-control-allow-origin')).toBe('*')

    await expect(
      new BASMRemote(unsupportedURL, TOPIC).requestTopicAnchorTip()
    ).rejects.toMatchObject({
      code: 'BASM_UNSUPPORTED'
    })
  }, 30000)
})
