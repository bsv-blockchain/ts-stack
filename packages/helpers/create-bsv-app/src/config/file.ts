// src/config/file.ts
import { readFileSync, existsSync } from 'node:fs'
import type { ProjectConfig, Mode } from './model.js'
import { resolveConfig, ConfigError } from './validate.js'

/** The parsed JSON of a `--file` config, not yet validated. */
export function readConfigFile(path: string): unknown {
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
  return parsed
}

export function resolveConfigFromFile(
  path: string,
  opts: { overrideMode?: Mode } = {}
): ProjectConfig {
  return resolveConfig(readConfigFile(path), opts)
}
