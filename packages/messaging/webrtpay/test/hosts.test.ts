import { describe, expect, it } from '@jest/globals'
import {
  HOST_TTL_MS,
  MAX_REMEMBERED_HOSTS,
  RecipientHosts,
  sameOrigin
} from '../src/signaling/hosts.js'

describe('RecipientHosts', () => {
  it('looks each recipient up once per TTL', async () => {
    let now = 0
    const asked: string[] = []
    const hosts = new RecipientHosts(
      k => {
        asked.push(k)
        return Promise.resolve(`https://${k}.example`)
      },
      () => now
    )
    expect(await hosts.of('a')).toBe('https://a.example')
    expect(await hosts.of('a')).toBe('https://a.example')
    now = HOST_TTL_MS
    await hosts.of('a')
    expect(asked).toEqual(['a', 'a'])
  })

  it('forgets a failed lookup and keeps at most the bound', async () => {
    let fail = true
    const asked: string[] = []
    const hosts = new RecipientHosts(k => {
      asked.push(k)
      return fail ? Promise.reject(new Error('down')) : Promise.resolve('https://h.example')
    })
    await expect(hosts.of('a')).rejects.toThrow('down')
    fail = false
    expect(await hosts.of('a')).toBe('https://h.example')
    for (let i = 0; i <= MAX_REMEMBERED_HOSTS; i++) await hosts.of(`k${i}`)
    asked.length = 0
    // 'a' was the oldest, so it was dropped; the newest is still remembered
    await hosts.of(`k${MAX_REMEMBERED_HOSTS}`)
    await hosts.of('a')
    expect(asked).toEqual(['a'])
  })

  it('a resolver that throws synchronously rejects', async () => {
    const hosts = new RecipientHosts(() => {
      throw new Error('sync')
    })
    await expect(hosts.of('a')).rejects.toThrow('sync')
  })
})

describe('sameOrigin', () => {
  it('compares origins and refuses junk', () => {
    expect(sameOrigin('https://mb.example', 'https://mb.example/path')).toBe(true)
    expect(sameOrigin('https://mb.example', 'https://mb.example:8443')).toBe(false)
    expect(sameOrigin('not a url', 'https://mb.example')).toBe(false)
  })
})
