import { describe, expect, test } from '@jest/globals'
import http from 'node:http'
import { buildUiHtml, parseUiSubmission, startUiServer } from '../ui'
import { listCapabilities } from '../registry'

describe('buildUiHtml', () => {
  test('fresh: contains html, both frameworks, all capability ids+titles', () => {
    const html = buildUiHtml({ existing: null })
    expect(html).toMatch(/<html/i)
    expect(html).toContain('express')
    expect(html).toContain('react')
    for (const cap of listCapabilities()) {
      expect(html).toContain(cap.id)
      expect(html).toContain(cap.title)
    }
  })

  test('existing: framework locked (react option disabled), installed caps not offered', () => {
    const existing = { version: 1 as const, name: 'myapp', network: 'test' as const, framework: 'express' as const, capabilities: ['wallet-login'] }
    const html = buildUiHtml({ existing })
    expect(html).toMatch(/react[^<]*disabled|disabled[^<]*react/i)
    expect(html).not.toMatch(/type="checkbox"[^>]*value="wallet-login"|value="wallet-login"[^>]*type="checkbox"/)
  })
})

describe('parseUiSubmission', () => {
  test('fresh: valid body maps to correct Selection', () => {
    const body = { appName: 'testapp', framework: 'react', network: 'test', capabilityIds: ['wallet-login'] }
    const sel = parseUiSubmission(body, null)
    expect(sel).toEqual({ appName: 'testapp', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
  })

  test('fresh: invalid framework throws', () => {
    const body = { appName: 'testapp', framework: 'angular', network: 'test', capabilityIds: ['wallet-login'] }
    expect(() => parseUiSubmission(body, null)).toThrow('invalid framework')
  })

  test('fresh: empty capabilities throws', () => {
    const body = { appName: 'testapp', framework: 'react', network: 'test', capabilityIds: [] }
    expect(() => parseUiSubmission(body, null)).toThrow('select at least one capability')
  })

  test('fresh: unknown capability throws', () => {
    const body = { appName: 'testapp', framework: 'react', network: 'test', capabilityIds: ['unknown-cap'] }
    expect(() => parseUiSubmission(body, null)).toThrow('unknown capability')
  })

  test('existing: framework forced to manifest framework', () => {
    const existing = { version: 1 as const, name: 'myapp', network: 'test' as const, framework: 'express' as const, capabilities: [] }
    const body = { appName: 'myapp', framework: 'react', network: 'test', capabilityIds: ['wallet-login'] }
    const sel = parseUiSubmission(body, existing)
    expect(sel.framework).toBe('express')
  })

  test('invalid body (array/primitive) throws', () => {
    expect(() => parseUiSubmission([], null)).toThrow('invalid body')
    expect(() => parseUiSubmission('string', null)).toThrow('invalid body')
    expect(() => parseUiSubmission(null, null)).toThrow('invalid body')
  })

  test('existing: capabilities unioned and deduped', () => {
    const existing = { version: 1 as const, name: 'myapp', network: 'test' as const, framework: 'express' as const, capabilities: ['wallet-login'] }
    const body = { appName: 'myapp', framework: 'express', network: 'test', capabilityIds: ['wallet-login'] }
    const sel = parseUiSubmission(body, existing)
    expect(sel.capabilityIds).toEqual(['wallet-login'])
  })
})

describe('startUiServer', () => {
  test('GET / returns 200 html with wallet-login; POST /generate resolves selection', async () => {
    const { url, selection, close } = await startUiServer({ existing: null })

    await new Promise<void>((resolve, reject) => {
      http.get(url, (res) => {
        expect(res.statusCode).toBe(200)
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => { chunks.push(d) })
        res.on('end', () => {
          const html = Buffer.concat(chunks).toString()
          expect(html).toContain('wallet-login')
          resolve()
        })
        res.on('error', reject)
      }).on('error', reject)
    })

    const payload = JSON.stringify({ appName: 'srv-test', framework: 'react', network: 'test', capabilityIds: ['wallet-login'] })
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(url)
      const req = http.request({
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: '/generate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        expect(res.statusCode).toBe(200)
        resolve()
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })

    const sel = await selection
    expect(sel).toMatchObject({ appName: 'srv-test', framework: 'react', capabilityIds: ['wallet-login'] })
    close()
  }, 10000)
})
