import {
  ConfigError,
  resolveConfig,
  validBsvDir
} from '../../packages/helpers/create-bsv-app/dist/config/validate.js'
import { attempt, invariant, utf8 } from '../lib.mjs'

function segment(data, start, length) {
  return data.subarray(start, start + length).toString('hex') || 'seed'
}

export function fuzz(data) {
  const raw = attempt(() => JSON.parse(utf8(data, 16_384)))
  if (raw.ok) {
    const resolved = attempt(() => resolveConfig(raw.value))
    if (resolved.ok) {
      invariant(resolved.value.name.length > 0, 'Project config resolved an empty name')
      invariant(validBsvDir(resolved.value.bsvDir), 'Project config resolved an unsafe BSV path')
    } else {
      let governed = false
      try {
        resolveConfig(raw.value)
      } catch (error) {
        governed = error instanceof ConfigError
      }
      invariant(governed, 'Project config escaped its governed error boundary')
    }
  }

  const bsvDir = `${segment(data, 0, 8)}/${segment(data, 8, 8)}`
  const client = `client/${segment(data, 16, 8)}`
  const server = `server/${segment(data, 24, 8)}`
  const resolved = resolveConfig({
    mode: 'add',
    name: `app-${segment(data, 32, 8)}`,
    bsvDir,
    targets: { client, server }
  })
  invariant(
    resolved.bsvDir === bsvDir &&
      resolved.targets.client === client &&
      resolved.targets.server === server,
    'Project config changed safe relative destinations'
  )

  for (const unsafe of [`../${bsvDir}`, `${bsvDir}/../escape`, `/${bsvDir}`, `C:\\${bsvDir}`]) {
    invariant(!validBsvDir(unsafe), 'Project config admitted an unsafe BSV path')
    invariant(!attempt(() => resolveConfig({ mode: 'add', name: 'app', bsvDir: unsafe })).ok)
  }
}
