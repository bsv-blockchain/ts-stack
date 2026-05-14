import { useCallback, useEffect, useRef, useState } from 'react'
import type { WalletInterface } from '@bsv/sdk'
import { WalletRelayClient, type WalletRelayClientOptions } from '../client/WalletRelayClient.js'
import type { SessionInfo, RequestLogEntry, WalletResponse, WalletMethodName } from '../types.js'

export type UseWalletRelayClientOptions = Omit<
  WalletRelayClientOptions,
  'onSessionChange' | 'onLogChange' | 'onError'
> & {
  /**
   * Set to `false` to prevent automatically creating a session on mount.
   * Default: `true`
   */
  autoCreate?: boolean
  /**
   * Set to `true` to attempt resuming a persisted session on mount even when
   * `autoCreate` is `false`. Lets a hook consumer survive page refreshes
   * without auto-creating a fresh session for users who never paired.
   * Default: `false` (so existing `autoCreate: false` consumers behave unchanged).
   *
   * Has no effect when `autoCreate !== false` — resume is already part of that path.
   */
  autoResume?: boolean
}

/**
 * React hook that wraps WalletRelayClient with React state.
 *
 * Replaces the template's `useWalletSession` hook — drop-in with a cleaner API.
 *
 * ```tsx
 * const { session, log, error, createSession, resumeSession, cancelSession, sendRequest } = useWalletRelayClient()
 *
 * // Stop polling and reset state (e.g. on page navigation away from a QR screen):
 * useEffect(() => () => { cancelSession() }, [])
 *
 * // With options:
 * const { session } = useWalletRelayClient({ apiUrl: 'https://api.example.com', autoCreate: false })
 * ```
 */
export function useWalletRelayClient(options?: UseWalletRelayClientOptions) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [log, setLog]         = useState<RequestLogEntry[]>([])
  const [error, setError]     = useState<string | null>(null)


  // Stable ref to the client instance — persists across StrictMode remounts
  const clientRef   = useRef<WalletRelayClient | null>(null)
  // In-flight guards: concurrent callers receive the same promise.
  const creatingRef = useRef<Promise<SessionInfo> | null>(null)
  const resumingRef = useRef<Promise<SessionInfo | null> | null>(null)

  // Lazily create the client once, wiring React state setters as callbacks
  function ensureClient(): WalletRelayClient {
    clientRef.current ??= new WalletRelayClient({
      apiUrl:                options?.apiUrl,
      pollInterval:          options?.pollInterval,
      connectedPollInterval: options?.connectedPollInterval,
      persistSession:        options?.persistSession,
      sessionStorageKey:     options?.sessionStorageKey,
      sessionStorageTtl:     options?.sessionStorageTtl,
      onSessionChange:       setSession,
      onLogChange:           setLog,
      onError:               setError,
    })
    return clientRef.current
  }

  const createSession = useCallback(async () => {
    if (creatingRef.current) return creatingRef.current
    setError(null)
    const promise: Promise<SessionInfo> = ensureClient().createSession().finally(() => {
      // Only clear if we're still the active in-flight promise
      if (creatingRef.current === promise) creatingRef.current = null
    })
    creatingRef.current = promise
    return promise
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const resumeSession = useCallback(async () => {
    if (resumingRef.current) return resumingRef.current
    setError(null)
    const promise: Promise<SessionInfo | null> = ensureClient().resumeSession().finally(() => {
      if (resumingRef.current === promise) resumingRef.current = null
    })
    resumingRef.current = promise
    return promise
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const cancelSession = useCallback(() => {
    const client = clientRef.current
    clientRef.current = null
    creatingRef.current = null
    resumingRef.current = null
    setSession(null)
    setError(null)
    setLog([])
    if (client) void client.disconnect()
  }, [])

  const sendRequest = useCallback(
    async (method: WalletMethodName, params?: unknown): Promise<WalletResponse> =>
      ensureClient().sendRequest(method, params),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    const wantCreate = options?.autoCreate !== false
    const wantResumeOnly = !wantCreate && options?.autoResume === true
    if (!wantCreate && !wantResumeOnly) return
    // setTimeout(0) prevents React strictmode double calls
    const timer = setTimeout(() => {
      void resumeSession().then(resumed => {
        if (!resumed && wantCreate) void createSession()
      })
    }, 0)
    return () => {
      clearTimeout(timer)
      const client = clientRef.current
      clientRef.current = null
      if (client) void client.disconnect()
    }
  }, [createSession, resumeSession]) // eslint-disable-line react-hooks/exhaustive-deps

  // Proxy is cached inside the client — null when no client or not connected
  const wallet: Pick<WalletInterface, WalletMethodName> | null =
    session?.status === 'connected' ? (clientRef.current?.wallet ?? null) : null

  return { session, log, error, createSession, resumeSession, cancelSession, sendRequest, wallet }
}
