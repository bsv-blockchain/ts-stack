import * as Utils from '../primitives/utils.js'
import { sha256 } from '../primitives/Hash.js'

const pending = new Map<string, Promise<void>>()
/** Same-origin Web Lock plus shared in-process fallback; no user data in lock names. */
export async function withKVWriteLock<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const name = `bsvsdk-kv:${Utils.toHex(sha256(Utils.toArray(scope, 'utf8')))}`
  const run = async (): Promise<T> => {
    const previous = pending.get(name) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const current = previous.then(async () => await gate)
    pending.set(name, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (pending.get(name) === current) pending.delete(name)
    }
  }
  const locks = globalThis.navigator?.locks
  return locks === undefined ? await run() : await locks.request(name, run)
}
