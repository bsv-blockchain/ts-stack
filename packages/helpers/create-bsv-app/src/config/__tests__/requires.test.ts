// src/config/__tests__/requires.test.ts
import { describe, expect, test } from '@jest/globals'
import { capabilityClosure, pulledCapabilities, formatPulledNotice } from '../requires'

describe('capabilityClosure', () => {
  test('adds what a capability requires', () => {
    expect(capabilityClosure(['tx-core'])).toEqual(['wallet-connect', 'tx-core'])
  })

  test('returns registry order whatever the request order', () => {
    expect(capabilityClosure(['tx-core', 'signed-requests', 'wallet-login'])).toEqual([
      'wallet-connect',
      'wallet-login',
      'signed-requests',
      'tx-core'
    ])
  })

  test('is idempotent', () => {
    const once = capabilityClosure(['signed-requests'])
    expect(capabilityClosure(once)).toEqual(once)
    expect(capabilityClosure([])).toEqual([])
  })
})

describe('pulledCapabilities', () => {
  test('lists each pulled capability with the members that require it', () => {
    expect(pulledCapabilities(['tx-core', 'wallet-login'])).toEqual([
      { id: 'wallet-connect', requiredBy: ['wallet-login', 'tx-core'] }
    ])
  })

  test('pulls nothing that was requested or is already installed', () => {
    expect(pulledCapabilities(['wallet-connect', 'tx-core'])).toEqual([])
    expect(pulledCapabilities(['tx-core'], ['wallet-connect'])).toEqual([])
  })
})

describe('formatPulledNotice', () => {
  test('one line per pulled capability', () => {
    expect(
      formatPulledNotice([{ id: 'wallet-connect', requiredBy: ['wallet-login', 'tx-core'] }])
    ).toEqual(['Also adding wallet-connect (required by wallet-login, tx-core).'])
    expect(formatPulledNotice([])).toEqual([])
  })
})
