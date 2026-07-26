import { describe, expect, test } from '@jest/globals'
import { openBrowser } from '../open-browser'

function capture(platform: NodeJS.Platform): { command: string; args: string[] } {
  let got: { command: string; args: string[] } | null = null
  openBrowser('http://127.0.0.1:5000', {
    platform,
    spawn: (command, args) => {
      got = { command, args }
    }
  })
  if (got === null) throw new Error('spawn was not called')
  return got
}

describe('openBrowser', () => {
  test('win32 uses cmd /c start', () => {
    const { command, args } = capture('win32')
    expect(command).toBe('cmd')
    expect(args).toEqual(['/c', 'start', '', 'http://127.0.0.1:5000'])
  })
  test('darwin uses open', () => {
    const { command, args } = capture('darwin')
    expect(command).toBe('open')
    expect(args).toEqual(['http://127.0.0.1:5000'])
  })
  test('linux uses xdg-open', () => {
    const { command, args } = capture('linux')
    expect(command).toBe('xdg-open')
    expect(args).toEqual(['http://127.0.0.1:5000'])
  })
  test('logs the url instead of throwing when spawn fails', () => {
    const logs: string[] = []
    openBrowser('http://127.0.0.1:5000', {
      platform: 'linux',
      spawn: () => {
        throw new Error('no display')
      },
      log: m => logs.push(m)
    })
    expect(logs.some(l => l.includes('http://127.0.0.1:5000'))).toBe(true)
  })
})
