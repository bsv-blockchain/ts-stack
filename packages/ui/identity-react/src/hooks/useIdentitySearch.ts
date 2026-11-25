import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  DisplayableIdentity,
  WalletInterface,
  IdentityClientOptions,
  OriginatorDomainNameStringUnder250Bytes
} from '@bsv/sdk'
import type { AutocompleteInputChangeReason } from '@mui/material/Autocomplete'
import { fetchIdentities } from '../utils/identityUtils'

export interface UseIdentitySearchProps {
  onIdentitySelected?: (selectedIdentity: DisplayableIdentity) => void
  wallet?: WalletInterface
  options?: Partial<IdentityClientOptions>
  originator?: OriginatorDomainNameStringUnder250Bytes
}

class SearchCache {
  private cache = new Map<string, { data: DisplayableIdentity[]; timestamp: number }>()

  get(query: string): DisplayableIdentity[] | null {
    const key = query.toLowerCase().trim()
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
      this.cache.delete(key)
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.data
  }

  set(query: string, data: DisplayableIdentity[]): void {
    const key = query.toLowerCase().trim()
    this.cache.delete(key)
    if (this.cache.size >= 100) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

/** Debounced identity search. Only complete successful results are cached per hook/context. */
export const useIdentitySearch = ({
  onIdentitySelected,
  wallet,
  options: providedOptions,
  originator
}: UseIdentitySearchProps = {}) => {
  // Routing options are a protocol tuple and scalars. Equivalent fresh objects
  // must not restart this effect on every state update.
  const options = useMemo<Partial<IdentityClientOptions> | undefined>(
    () =>
      providedOptions
        ? {
            ...providedOptions,
            ...(providedOptions.protocolID
              ? {
                  protocolID: [
                    providedOptions.protocolID[0],
                    providedOptions.protocolID[1]
                  ] as IdentityClientOptions['protocolID']
                }
              : {})
          }
        : undefined,
    [
      providedOptions?.protocolID?.[0],
      providedOptions?.protocolID?.[1],
      providedOptions?.keyID,
      providedOptions?.tokenAmount,
      providedOptions?.outputIndex,
      providedOptions?.networkPreset
    ]
  )
  const [inputValue, setInputValue] = useState('')
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [identities, setIdentities] = useState<DisplayableIdentity[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [contactWarning, setContactWarning] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const cache = useRef(new SearchCache())
  const requestId = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const justSelected = useRef<string | null>(null)
  const context = useRef({ wallet, options, originator })

  const invalidate = useCallback(() => {
    requestId.current++
    controller.current?.abort()
    controller.current = null
  }, [])

  useEffect(() => {
    invalidate()
    if (
      context.current.wallet !== wallet ||
      context.current.options !== options ||
      context.current.originator !== originator
    ) {
      cache.current.clear()
      context.current = { wallet, options, originator }
    }
    setSearchError(null)
    setContactWarning(null)
    const selectedInput = justSelected.current
    justSelected.current = null
    if (selectedInput !== null && selectedInput === inputValue) {
      setIsLoading(false)
      return
    }

    const query = inputValue.trim()
    if (!query) {
      setIdentities([])
      setIsLoading(false)
      return
    }
    const cached = cache.current.get(query)
    if (cached) {
      setIdentities(cached)
      setIsLoading(false)
      return
    }

    setIdentities([])
    setIsLoading(true)
    const currentRequest = requestId.current
    const abort = new AbortController()
    controller.current = abort
    const current = () => requestId.current === currentRequest && !abort.signal.aborted
    const timeout = setTimeout(() => {
      let partial = false
      void fetchIdentities(query, wallet, options, originator, abort.signal, () => {
        partial = true
        if (current())
          setContactWarning('Saved contacts are unavailable. Results may exclude saved contacts.')
      })
        .then((result) => {
          if (!current()) return
          setIdentities(result)
          if (!partial) cache.current.set(query, result)
        })
        .catch(() => {
          if (!current()) return
          setIdentities([])
          setContactWarning(null)
          setSearchError('Identity lookup failed. Check wallet access and try again.')
        })
        .finally(() => {
          if (current()) setIsLoading(false)
        })
    }, 400)

    return () => {
      clearTimeout(timeout)
      abort.abort()
    }
  }, [inputValue, wallet, options, originator, retryVersion, invalidate])

  useEffect(
    () => () => {
      invalidate()
    },
    [invalidate]
  )

  const handleInputChange = useCallback(
    (_: React.SyntheticEvent | null, value: string, reason: AutocompleteInputChangeReason) => {
      if (value === inputValue) return
      // Supersede old work immediately, including when the new query is a cache hit.
      invalidate()
      setSearchError(null)
      setContactWarning(null)
      setIsLoading(Boolean(value.trim()) && reason !== 'reset')
      setInputValue(value)
    },
    [inputValue, invalidate]
  )

  const handleSelect = useCallback(
    (_: React.SyntheticEvent | null, value: DisplayableIdentity | string | null) => {
      invalidate()
      setIsLoading(false)
      setSearchError(null)
      setContactWarning(null)
      if (value && typeof value !== 'string') {
        justSelected.current = value.name
        setIdentities([])
        setInputValue(value.name)
        setSelectedIdentity(value)
        onIdentitySelected?.(value)
      } else {
        setSelectedIdentity(null)
      }
    },
    [invalidate, onIdentitySelected]
  )

  const clearCache = useCallback(() => {
    cache.current.clear()
  }, [])
  const retrySearch = useCallback(() => {
    invalidate()
    cache.current.clear()
    justSelected.current = null
    setRetryVersion((version) => version + 1)
  }, [invalidate])

  return useMemo(
    () => ({
      inputValue,
      isLoading,
      identities,
      selectedIdentity,
      searchError,
      contactWarning,
      handleInputChange,
      handleSelect,
      clearCache,
      retrySearch
    }),
    [
      inputValue,
      isLoading,
      identities,
      selectedIdentity,
      searchError,
      contactWarning,
      handleInputChange,
      handleSelect,
      clearCache,
      retrySearch
    ]
  )
}
