// src/scaffold/run-command.ts
import { spawnSync } from 'node:child_process'
import type { RunCommand } from './base-scaffolder.js'

export const defaultRunCommand: RunCommand = (command, args, opts) => {
  const res = spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' // npm/pnpm/yarn/bun are .cmd shims on Windows
  })
  if (res.error != null) throw res.error
  if (res.status !== 0) throw new Error(`command failed (${String(res.status)}): ${command} ${args.join(' ')}`)
}
