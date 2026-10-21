// Shared source watcher and hidden environment-file restart for Node 24 services.
import { spawn } from 'node:child_process'
import { watchFile, unwatchFile } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function watchDevelopmentService(serviceModuleUrl) {
  const cli = fileURLToPath(new URL('./node_modules/tsx/dist/cli.mjs', serviceModuleUrl))
  const child = spawn(
    process.execPath,
    [cli, 'watch', '--include', 'src/**', ...process.argv.slice(2)],
    {
      stdio: ['pipe', 'inherit', 'inherit']
    }
  )
  process.stdin.pipe(child.stdin, { end: false })
  watchFile('.env', { interval: 500 }, (current, previous) => {
    if (
      (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) &&
      !child.stdin.destroyed
    ) {
      child.stdin.write('\n')
    }
  })
  const cleanup = () => {
    unwatchFile('.env')
    process.stdin.unpipe(child.stdin)
    process.stdin.pause()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup()
      child.kill(signal)
    })
  }
  child.on('error', error => {
    cleanup()
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    cleanup()
    process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1)
  })
}
