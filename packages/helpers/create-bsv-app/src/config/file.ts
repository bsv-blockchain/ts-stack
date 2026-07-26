// src/config/file.ts
import { readFileSync, existsSync } from 'node:fs'
import type { ProjectConfig, Mode } from './model.js'
import { resolveConfig, ConfigError } from './validate.js'

export function resolveConfigFromFile(
  path: string,
  opts: { overrideMode?: Mode } = {}
): ProjectConfig {
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ConfigError(`cannot read config file: ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(`invalid JSON in ${path}`)
  }
  return resolveConfig(parsed, opts)
}
