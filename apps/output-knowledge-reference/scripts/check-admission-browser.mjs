import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createMongoReplicaFixture } from '../../../packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'

// Node 24 strips this standalone fixture's types. It owns only fresh databases,
// temporary mongod files and loopback ports; no deployed database is contacted.
const replica = await createMongoReplicaFixture()
let child
let termination
const stop = () => {
  if (child?.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  termination ??= setTimeout(() => child.kill('SIGKILL'), 10000)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  // A single loopback seed still discovers the owned three-member replica set.
  const uri = replica.uri.replace(/,127\.0\.0\.1:\d+/g, '')
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./check-browser.mjs', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env,
        REFERENCE_ADMISSION_URI: uri,
        REFERENCE_DIAGNOSTICS: '1',
        REFERENCE_ADMISSION_DATABASE: 'output_reference_' + randomUUID().replaceAll('-', '')
      },
      stdio: 'inherit'
    }
  )
  await new Promise((resolve, reject) => {
    const timer = setTimeout(stop, 300000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(termination)
      if (code === 0) resolve()
      else reject(new Error('Admission browser qualification failed: ' + (signal ?? code)))
    })
  })
} finally {
  clearTimeout(termination)
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  await replica.close()
}
