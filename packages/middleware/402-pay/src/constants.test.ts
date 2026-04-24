import { describe, it, expect } from 'vitest'
import { HEADERS, HEADER_PREFIX, BRC29_PROTOCOL_ID, DEFAULT_PAYMENT_WINDOW_MS } from './constants.js'

describe('constants', () => {
  describe('HEADER_PREFIX', () => {
    it('is the bsv prefix string', () => {
      expect(HEADER_PREFIX).toBe('x-bsv-')
    })
  })

  describe('DEFAULT_PAYMENT_WINDOW_MS', () => {
    it('is 30 seconds in milliseconds', () => {
      expect(DEFAULT_PAYMENT_WINDOW_MS).toBe(30_000)
    })
  })

  describe('BRC29_PROTOCOL_ID', () => {
    it('is a tuple with security level 2', () => {
      expect(BRC29_PROTOCOL_ID[0]).toBe(2)
    })

    it('has the correct protocol string', () => {
      expect(BRC29_PROTOCOL_ID[1]).toBe('3241645161d8')
    })
  })

  describe('HEADERS', () => {
    it('all values start with the header prefix', () => {
      for (const value of Object.values(HEADERS)) {
        expect(value).toMatch(/^x-bsv-/)
      }
    })

    it('has the correct server-to-client headers', () => {
      expect(HEADERS.SATS).toBe('x-bsv-sats')
      expect(HEADERS.SERVER).toBe('x-bsv-server')
    })

    it('has the correct client-to-server headers', () => {
      expect(HEADERS.BEEF).toBe('x-bsv-beef')
      expect(HEADERS.SENDER).toBe('x-bsv-sender')
      expect(HEADERS.NONCE).toBe('x-bsv-nonce')
      expect(HEADERS.TIME).toBe('x-bsv-time')
      expect(HEADERS.VOUT).toBe('x-bsv-vout')
    })

    it('has exactly 7 headers', () => {
      expect(Object.keys(HEADERS)).toHaveLength(7)
    })
  })
})
