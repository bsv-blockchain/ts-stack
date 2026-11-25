import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisplayableIdentity, defaultIdentity } from '@bsv/sdk'
import IdentitySearchField from '../src/components/IdentitySearchField'
import { fetchIdentities } from '../src/utils/identityUtils'

vi.mock('../src/utils/identityUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/identityUtils')>()),
  fetchIdentities: vi.fn()
}))
vi.mock('@bsv/uhrp-react', () => ({ Img: () => null }))
vi.mock('metanet-react-prompt', () => ({ NoMncModal: () => null }))
const fetch = vi.mocked(fetchIdentities)
const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const identity: DisplayableIdentity = { ...defaultIdentity, name: 'Alice', identityKey: key }
const search = async (query: string) => {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: query } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  fetch.mockReset()
  fetch.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('visible search feedback', () => {
  it('renders a public lookup failure and retry without presenting a raw key as a discovered identity', async () => {
    fetch
      .mockRejectedValueOnce(new Error('sensitive wallet detail'))
      .mockResolvedValueOnce([identity])
    render(<IdentitySearchField />)
    await search(key)
    expect(screen.getByRole('alert').textContent).toMatch(/Identity lookup failed/)
    expect(screen.queryByText('No identities found')).toBeNull()
    expect(screen.queryByText('Custom Identity Key')).toBeNull()
    expect(screen.queryByText(/sensitive wallet detail/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry identity search' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('renders a recovered result and a contact warning and allows recipient selection', async () => {
    fetch.mockImplementation(async (_query, _wallet, _options, _originator, _signal, warning) => {
      warning?.(new Error('synthetic contact denial'))
      return [identity]
    })
    const selected = vi.fn()
    render(<IdentitySearchField onIdentitySelected={selected} />)
    await search('alice')
    expect(screen.getByRole('status').textContent).toMatch(/Saved contacts are unavailable/)
    fireEvent.click(screen.getByRole('option', { name: /Alice/ }))
    expect(selected).toHaveBeenCalledExactlyOnceWith(identity)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('uses the empty-result message only for a successful empty lookup', async () => {
    render(<IdentitySearchField />)
    await search('nobody')
    expect(screen.getByText('No identities found')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
