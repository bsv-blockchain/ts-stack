import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { IdentityClient, type DisplayableIdentity } from '@bsv/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import IdentityCard from '../src/components/IdentityCard'
import { DEFAULT_IDENTITY } from '../src/types'

vi.mock('@bsv/uhrp-react', () => ({ Img: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('never replaces the current identity with a late result for a previous key', async () => {
  const x = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const alice = { ...DEFAULT_IDENTITY, name: 'Alice', identityKey: `02${x}` }
  const bob = { ...DEFAULT_IDENTITY, name: 'Bob', identityKey: `03${x}` }
  let completeAlice: (value: DisplayableIdentity[]) => void = () => {}
  const delayedAlice = new Promise<DisplayableIdentity[]>((resolve) => {
    completeAlice = resolve
  })
  vi.spyOn(IdentityClient.prototype, 'resolveByIdentityKey')
    .mockReturnValueOnce(delayedAlice)
    .mockResolvedValueOnce([bob])
    .mockResolvedValueOnce([])

  const { rerender } = render(<IdentityCard identityKey={alice.identityKey} />)
  rerender(<IdentityCard identityKey={bob.identityKey} />)
  expect(await screen.findByText('Bob')).toBeTruthy()

  await act(async () => completeAlice([alice]))
  expect(screen.getByText('Bob')).toBeTruthy()
  expect(screen.queryByText('Alice')).toBeNull()

  rerender(<IdentityCard identityKey="missing" />)
  expect(await screen.findByText(DEFAULT_IDENTITY.name)).toBeTruthy()
  expect(screen.queryByText('Bob')).toBeNull()
})
