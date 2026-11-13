import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** The parent sends a bounded synthetic job through its existing IPC channel.
 * Workers never open a caller-selected CLI JSON file. Native database access is
 * restricted to an existing disposable fixture directly below the real temp root.
 */
export async function fixtureJob(prefix) {
  const input = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', receive)
      reject(new Error('Fixture initialization deadline'))
    }, 10000)
    function receive(message) {
      clearTimeout(timer)
      try {
        const encoded = JSON.stringify(message)
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2097152)
          throw new Error('Fixture job exceeds bound')
        resolve(JSON.parse(encoded))
      } catch (error) {
        reject(error)
      }
    }
    process.once('message', receive)
  })
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.path !== 'string' ||
    input.path.length > 2048
  )
    throw new Error('Invalid fixture initialization')
  const path = realpathSync(input.path),
    directory = dirname(path),
    name = basename(directory)
  if (
    basename(path) !== 'private.db' ||
    dirname(directory) !== realpathSync(tmpdir()) ||
    !name.startsWith(prefix) ||
    !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length)) ||
    path !== join(realpathSync(dirname(input.path)), 'private.db')
  )
    throw new Error('Database is outside the disposable fixture')
  return { ...input, path }
}
