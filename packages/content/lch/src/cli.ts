#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { parseLCH } from './framing.js'
import { objectIri, toHex } from './hash.js'
import type { LCHValue } from './types.js'

export interface LCHCLIRuntime {
  args: string[]
  read(path: string): Promise<Uint8Array>
  write(message: string): void
}

function usage(): string {
  return 'Usage: lch <command> [file]\n\nCommands:\n  inspect <file>     Decode an .lch header\n  verify <file>      Verify framing and canonical CBOR\n  id <type> <file>   Compute an object IRI from CBOR\n  --help             Show this help\n'
}

function diagnostic(value: LCHValue): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64url') }
  }
  if (typeof value === 'bigint') return { $uint: value.toString() }
  if (Array.isArray(value)) return value.map(diagnostic)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnostic(item)]))
  }
  return value
}

export async function runLCHCLI(runtime: LCHCLIRuntime): Promise<void> {
  const [command, first, second] = runtime.args
  if (command === undefined || command === '--help' || command === '-h') {
    runtime.write(usage())
    return
  }
  if (command === 'inspect' || command === 'verify') {
    if (first === undefined) throw new Error('A file path is required')
    const parsed = parseLCH(await runtime.read(first))
    if (command === 'inspect') {
      runtime.write(JSON.stringify(diagnostic(parsed.header), null, 2) + '\n')
    } else {
      runtime.write(
        'valid header=' +
          parsed.headerBytes.length +
          ' ciphertext=' +
          (parsed.ciphertext?.length ?? 0) +
          '\n'
      )
    }
    return
  }
  if (command === 'id') {
    if (first === undefined || second === undefined) {
      throw new Error('Object type and CBOR file are required')
    }
    const bytes = await runtime.read(second)
    const body = decodeDeterministicCbor(bytes)
    if (toHex(encodeDeterministicCbor(body)) !== toHex(bytes)) {
      throw new Error('CBOR is not canonical')
    }
    runtime.write((await objectIri(first as never, body)) + '\n')
    return
  }
  throw new Error('Unknown command: ' + command)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runLCHCLI({
    args: process.argv.slice(2),
    read: async path => new Uint8Array(await readFile(path)),
    write: message => process.stdout.write(message)
  }).catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  })
}
