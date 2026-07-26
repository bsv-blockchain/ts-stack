// src/scaffold/run-command.ts
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import type { RunCommand } from './base-scaffolder.js'

export interface SpawnResult {
  status: number | null
  error?: Error
}
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: SpawnSyncOptions
) => SpawnResult

export function makeRunCommand(spawn: SpawnSyncFn): RunCommand {
  return (command, args, opts) => {
    const res = spawn(command, args, {
      cwd: opts.cwd,
      // stdin is NOT inherited: clack-based generators (e.g. create-vite) fall back to
      // their non-interactive defaults with the flags we pass, instead of prompting on the
      // TTY. A prompt here would block (or be cancelled), throw, and abort the rest of
      // scaffolding. stdout/stderr stay inherited so the user still sees progress.
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32' // npm/pnpm/yarn/bun are .cmd shims on Windows
    })
    if (res.error != null) throw res.error
    if (res.status !== 0)
      throw new Error(`command failed (${String(res.status)}): ${command} ${args.join(' ')}`)
  }
}

export const defaultRunCommand: RunCommand = makeRunCommand((command, args, options) =>
  spawnSync(command, args, options)
)
