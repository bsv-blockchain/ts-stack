import {
  DEFAULT_STORAGE_URL,
  parseCliArguments
} from '../../packages/helpers/fund-wallet/dist/cli.mjs'
import { deepEqual, invariant, utf8 } from '../lib.mjs'

const PRIVATE_KEY = '1'.repeat(64)

export function fuzz(data) {
  const arguments_ = utf8(data, 8192).split('\0').slice(0, 40)
  const parsed = parseCliArguments(arguments_)
  invariant(
    ['help', 'interactive', 'run', 'error'].includes(parsed.kind),
    'Fund-wallet parser returned an unknown result'
  )

  const chain = (data[0] ?? 0) % 2 === 0 ? 'main' : 'test'
  const amountBytes = Buffer.alloc(6)
  data.copy(amountBytes, 0, 1, Math.min(data.length, 7))
  const amount = amountBytes.readUIntBE(0, 6)
  deepEqual(
    parseCliArguments([
      '--chain',
      chain,
      '--private-key',
      PRIVATE_KEY,
      '--satoshis',
      String(amount)
    ]),
    {
      kind: 'run',
      options: {
        chain,
        storageURL: DEFAULT_STORAGE_URL,
        privateKey: PRIVATE_KEY,
        amount
      }
    },
    'Fund-wallet parser changed valid CLI options'
  )

  const host = data.subarray(7, 39).toString('hex') || 'seed'
  const base = ['--chain', chain, '--private-key', PRIVATE_KEY, '--storage-url']
  invariant(
    parseCliArguments([...base, `http://${host}.example.org`]).kind === 'error',
    'Fund-wallet accepted an insecure storage endpoint'
  )
  invariant(
    parseCliArguments([...base, `https://user:secret@${host}.example.org`]).kind === 'error',
    'Fund-wallet accepted storage URL credentials'
  )
}
