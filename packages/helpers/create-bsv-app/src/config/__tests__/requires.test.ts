// src/config/__tests__/requires.test.ts
import { describe, expect, test } from '@jest/globals'
import { capabilityClosure, pulledCapabilities, formatPulledNotice } from '../requires'
import { requiredIds } from '../../registry'
import { txCore } from '../../capabilities/tx-core'

describe('capabilityClosure', () => {
  test('adds what a capability requires', () => {
    expect(capabilityClosure(['wallet-login'], 'backend-only')).toEqual([
      'wallet-connect',
      'wallet-login'
    ])
  })

  test('returns registry order whatever the request order', () => {
    expect(capabilityClosure(['tx-core', 'signed-requests', 'wallet-login'], 'monorepo')).toEqual([
      'wallet-connect',
      'wallet-login',
      'signed-requests',
      'tx-core'
    ])
  })

  test('is idempotent', () => {
    const once = capabilityClosure(['signed-requests'], 'monorepo')
    expect(capabilityClosure(once, 'monorepo')).toEqual(once)
    expect(capabilityClosure([], 'monorepo')).toEqual([])
  })

  test('a role-scoped requirement applies only where the layout places that role', () => {
    // tx-core needs wallet-connect only for its client demo page
    expect(capabilityClosure(['tx-core'], 'backend-only')).toEqual(['tx-core'])
    expect(capabilityClosure(['tx-core'], 'frontend-only')).toEqual(['wallet-connect', 'tx-core'])
    expect(capabilityClosure(['tx-core'], 'monorepo')).toEqual(['wallet-connect', 'tx-core'])
  })
})

describe('requiredIds', () => {
  test('a plain id always applies; a role-scoped one only where the layout has the role', () => {
    const cap = {
      ...txCore,
      requires: ['wallet-login', { id: 'wallet-connect', role: 'client' as const }]
    }
    expect(requiredIds(cap, 'backend-only')).toEqual(['wallet-login'])
    expect(requiredIds(cap, 'frontend-only')).toEqual(['wallet-login', 'wallet-connect'])
    expect(requiredIds({ ...cap, requires: undefined }, 'monorepo')).toEqual([])
  })
})

describe('pulledCapabilities', () => {
  test('lists each pulled capability with the members that require it', () => {
    expect(pulledCapabilities(['tx-core', 'wallet-login'], 'monorepo')).toEqual([
      { id: 'wallet-connect', requiredBy: ['wallet-login', 'tx-core'] }
    ])
  })

  test('pulls nothing that was requested or is already installed', () => {
    expect(pulledCapabilities(['wallet-connect', 'tx-core'], 'monorepo')).toEqual([])
    expect(pulledCapabilities(['tx-core'], 'monorepo', ['wallet-connect'])).toEqual([])
  })

  test('names only the members whose requirement applies in the layout', () => {
    expect(pulledCapabilities(['tx-core'], 'backend-only')).toEqual([])
    expect(pulledCapabilities(['tx-core', 'wallet-login'], 'backend-only')).toEqual([
      { id: 'wallet-connect', requiredBy: ['wallet-login'] }
    ])
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
