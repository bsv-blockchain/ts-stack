import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisplayableIdentity, WalletInterface } from '@bsv/sdk'
import { useIdentitySearch, UseIdentitySearchProps } from '../src/hooks/useIdentitySearch'
import { fetchIdentities } from '../src/utils/identityUtils'

vi.mock('../src/utils/identityUtils', () => ({ fetchIdentities: vi.fn() }))
const fetch = vi.mocked(fetchIdentities)
const identity = (name: string) => ({ name, identityKey: name }) as DisplayableIdentity
const input = (
  hook: ReturnType<typeof renderHook<ReturnType<typeof useIdentitySearch>, UseIdentitySearchProps>>,
  query: string
) => {
  act(() => hook.result.current.handleInputChange({} as React.SyntheticEvent, query, 'input'))
}
const settle = async () => {
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

describe('search results and failure state', () => {
  it('does not restart a lookup for equivalent freshly allocated routing options', async () => {
    const hook = renderHook(() =>
      useIdentitySearch({
        options: {
          protocolID: [1, 'identity'],
          keyID: '1',
          tokenAmount: 1,
          outputIndex: 0
        }
      })
    )
    input(hook, 'alice')
    await settle()
    hook.rerender()
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(hook.result.current.isLoading).toBe(false)
  })
  it('accepts partial SDK routing options without overwriting default protocol fields', async () => {
    const hook = renderHook((props: UseIdentitySearchProps) => useIdentitySearch(props), {
      initialProps: { options: { networkPreset: 'testnet' } }
    })
    input(hook, 'alice')
    await settle()
    expect(fetch.mock.calls[0][2]).toEqual({ networkPreset: 'testnet' })
    hook.rerender({ options: { networkPreset: 'mainnet' } })
    await settle()
    expect(fetch.mock.calls[1][2]).toEqual({ networkPreset: 'mainnet' })
  })
  it('invalidates cached results when the originator or routing options change', async () => {
    const hook = renderHook((props) => useIdentitySearch(props), {
      initialProps: {
        originator: 'first.example',
        options: { protocolID: [1, 'identity'], keyID: '1', tokenAmount: 1, outputIndex: 0 }
      } as UseIdentitySearchProps
    })
    input(hook, 'alice')
    await settle()
    hook.rerender({ originator: 'second.example' })
    await settle()
    expect(fetch.mock.calls[1][3]).toBe('second.example')
    hook.rerender({
      originator: 'second.example',
      options: { protocolID: [1, 'identity'], keyID: '2', tokenAmount: 1, outputIndex: 0 }
    })
    await settle()
    expect(fetch.mock.calls[2][2]?.keyID).toBe('2')
  })
  it('expires old query results and refreshes contacts after five minutes', async () => {
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    })
    input(hook, 'bob')
    await settle()
    input(hook, 'alice')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('keeps the query cache bounded and retains its most recent result', async () => {
    const hook = renderHook(() => useIdentitySearch())
    for (let i = 0; i <= 100; i++) {
      input(hook, 'query' + i)
      await settle()
    }
    input(hook, 'query99')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(101)
    input(hook, 'query0')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(102)
  })
  it('retains a recently accessed entry when the least recently used query is evicted', async () => {
    const hook = renderHook(() => useIdentitySearch())
    for (let i = 0; i < 100; i++) {
      input(hook, 'query' + i)
      await settle()
    }
    input(hook, 'query0')
    await settle()
    input(hook, 'query100')
    await settle()
    input(hook, 'query0')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(101)
    input(hook, 'query1')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(102)
  })
  it('replaces a contact warning with the public lookup error if discovery fails', async () => {
    fetch.mockImplementation(async (_query, _wallet, _options, _originator, _signal, warn) => {
      warn?.(new Error('synthetic contact denial'))
      throw new Error('synthetic public failure')
    })
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    expect(hook.result.current.contactWarning).toBeNull()
    expect(hook.result.current.searchError).toMatch(/Identity lookup failed/)
  })

  it('shows public failure separately from successful empty results and retries the same query', async () => {
    fetch.mockRejectedValueOnce(new Error('private wallet detail')).mockResolvedValueOnce([])
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    expect(hook.result.current.searchError).toMatch(/Identity lookup failed/)
    expect(hook.result.current.searchError).not.toContain('private wallet detail')
    act(() => hook.result.current.retrySearch())
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(hook.result.current.searchError).toBeNull()
    expect(hook.result.current.identities).toEqual([])
    expect(hook.result.current.isLoading).toBe(false)
  })
  it('keeps recovered results with a warning and never caches the partial answer', async () => {
    fetch.mockImplementation(async (_query, _wallet, _options, _originator, _signal, warn) => {
      warn?.(new Error('synthetic contact denial'))
      return [identity('Public Alice')]
    })
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    expect(hook.result.current.identities[0].name).toBe('Public Alice')
    expect(hook.result.current.contactWarning).toMatch(/Saved contacts are unavailable/)
    input(hook, 'other')
    await settle()
    input(hook, 'alice')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('cannot overwrite a new cache hit with an older result or warning', async () => {
    let finish!: (result: DisplayableIdentity[]) => void
    let warn: ((error: unknown) => void) | undefined
    fetch
      .mockResolvedValueOnce([identity('Cached Alice')])
      .mockImplementationOnce((_query, _wallet, _options, _originator, _signal, warning) => {
        warn = warning
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    input(hook, 'bob')
    await settle()
    input(hook, 'alice')
    await act(async () => {
      warn?.(new Error('late'))
      finish([identity('Stale Bob')])
    })
    expect(hook.result.current.identities[0].name).toBe('Cached Alice')
    expect(hook.result.current.contactWarning).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('clearing input prevents late failures or results from returning', async () => {
    let fail!: (error: Error) => void
    fetch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    input(hook, '')
    await act(async () => {
      fail(new Error('late error'))
    })
    expect(hook.result.current.identities).toEqual([])
    expect(hook.result.current.searchError).toBeNull()
    expect(hook.result.current.isLoading).toBe(false)
  })
  it('does not reuse another hook or wallet context result', async () => {
    fetch
      .mockResolvedValueOnce([identity('Wallet One')])
      .mockResolvedValueOnce([identity('Wallet Two')])
    const one = {} as WalletInterface,
      two = {} as WalletInterface
    const hook = renderHook((props) => useIdentitySearch(props), { initialProps: { wallet: one } })
    input(hook, 'alice')
    await settle()
    hook.rerender({ wallet: two })
    await settle()
    expect(hook.result.current.identities[0].name).toBe('Wallet Two')
    expect(fetch.mock.calls[1][1]).toBe(two)
    const second = renderHook(() => useIdentitySearch({ wallet: two }))
    input(second, 'alice')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('clearing the cache refreshes a previously complete answer on retry', async () => {
    fetch.mockResolvedValueOnce([identity('Before')]).mockResolvedValueOnce([identity('After')])
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    act(() => {
      hook.result.current.clearCache()
      hook.result.current.retrySearch()
    })
    await settle()
    expect(hook.result.current.identities[0].name).toBe('After')
  })
  it('selection aborts old work and invokes the recipient callback once', async () => {
    const selected = vi.fn()
    const hook = renderHook(() => useIdentitySearch({ onIdentitySelected: selected }))
    input(hook, 'alice')
    await settle()
    const value = identity('Selected Alice')
    act(() => hook.result.current.handleSelect({} as React.SyntheticEvent, value))
    await settle()
    expect(selected).toHaveBeenCalledExactlyOnceWith(value)
    expect(hook.result.current.selectedIdentity).toBe(value)
    expect(hook.result.current.isLoading).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('searches the next input after selecting an identity whose name already matches the query', async () => {
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'Alice')
    await settle()
    act(() => hook.result.current.handleSelect(null, identity('Alice')))
    input(hook, 'Bob')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toBe('Bob')
    expect(hook.result.current.isLoading).toBe(false)
  })
  it('aborts result delivery when unmounted', async () => {
    fetch.mockImplementation(() => new Promise(() => {}))
    const hook = renderHook(() => useIdentitySearch())
    input(hook, 'alice')
    await settle()
    const signal = fetch.mock.calls[0][4]
    hook.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
