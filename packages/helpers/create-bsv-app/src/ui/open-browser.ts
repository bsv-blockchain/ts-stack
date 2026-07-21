import { spawn as nodeSpawn } from 'node:child_process'

export type SpawnFn = (command: string, args: string[]) => void

const defaultSpawn: SpawnFn = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}

function launchFor (platform: NodeJS.Platform, url: string): { command: string, args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

export function openBrowser (
  url: string,
  deps: { platform?: NodeJS.Platform, spawn?: SpawnFn, log?: (msg: string) => void } = {}
): void {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? defaultSpawn
  const log = deps.log ?? ((m: string) => console.log(m))
  const { command, args } = launchFor(platform, url)
  try {
    spawn(command, args)
  } catch {
    log(`Open this URL in your browser:\n  ${url}`)
  }
}
