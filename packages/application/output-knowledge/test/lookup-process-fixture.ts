import { spawn, type ChildProcess } from 'node:child_process'

export function startLookupProcess(script: string, input: unknown, processes: Set<ChildProcess>) {
  const child = spawn(process.execPath, [script, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  processes.add(child)
  const messages: { status: string; sequence?: string; session?: string; code?: string }[] = []
  let stderr = ''
  let timedOut = false
  child.stderr!.on('data', chunk => {
    stderr += String(chunk)
  })
  let ready: () => void
  const started = new Promise<void>(resolve => {
    ready = resolve
  })
  child.on('message', message => {
    const value = message as (typeof messages)[number]
    messages.push(value)
    if (value.status === 'ready') ready()
  })
  const done = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stderr: string
    timedOut: boolean
  }>((resolve, reject) => {
    child.once('error', error => {
      processes.delete(child)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      processes.delete(child)
      resolve({ code, signal, stderr, timedOut })
    })
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 10000)
  const finished = done.finally(() => clearTimeout(timer))
  return {
    child,
    messages,
    started: Promise.race([
      started,
      finished.then(() => {
        throw new Error('Child exited before readiness: ' + stderr)
      })
    ]),
    finished
  }
}
