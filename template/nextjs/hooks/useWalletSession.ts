'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from 'qr-lib/client'
import type { RequestLogEntry, WalletMethod, WalletRequest, WalletResponse } from '../types/wallet'

// Next.js API routes are on the same origin — no proxy configuration needed.
// If you move API routes to a different origin, update this constant.
const API = '/api'
const POLL_INTERVAL_MS = 3000

export function useWalletSession() {
  const [session, setSession]   = useState<SessionInfo | null>(null)
  const [log, setLog]           = useState<RequestLogEntry[]>([])
  const [error, setError]       = useState<string | null>(null)
  const pollRef                 = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionCreated          = useRef(false)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const createSession = useCallback(async () => {
    setError(null)
    try {
      const res  = await fetch(`${API}/session`)
      const data = (await res.json()) as SessionInfo
      setSession(data)

      // Stop only when 'expired' (truly terminal).
      // Do NOT stop on 'disconnected': the mobile can reconnect to the same session
      // and the backend will flip status back to 'connected' when it does.
      let expiredCount = 0
      pollRef.current = setInterval(async () => {
        const statusRes = await fetch(`${API}/session/${data.sessionId}`)
        const updated   = (await statusRes.json()) as SessionInfo
        setSession(prev => ({ ...prev!, ...updated }))
        if (updated.status === 'expired') {
          if (++expiredCount >= 2) stopPolling()
        } else {
          expiredCount = 0
        }
      }, POLL_INTERVAL_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    }
  }, [])

  const sendRequest = useCallback(
    async (method: WalletMethod, params: unknown = {}): Promise<WalletResponse | null> => {
      if (!session) return null

      const tempRequest: WalletRequest = {
        requestId: crypto.randomUUID(),
        method,
        params,
        timestamp: Date.now(),
      }
      const entry: RequestLogEntry = { request: tempRequest, pending: true }
      setLog(prev => [entry, ...prev])

      try {
        const res = await fetch(`${API}/request/${session.sessionId}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ method, params }),
        })
        const rpc = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
        const response: WalletResponse = {
          requestId: tempRequest.requestId,
          result:    rpc.result,
          error:     rpc.error,
          timestamp: Date.now(),
        }
        setLog(prev =>
          prev.map(e =>
            e.request.requestId === tempRequest.requestId
              ? { ...e, response, pending: false }
              : e
          )
        )
        return response
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Request failed'
        setLog(prev =>
          prev.map(e =>
            e.request.requestId === tempRequest.requestId
              ? {
                  ...e,
                  response: {
                    requestId: tempRequest.requestId,
                    error: { code: 500, message: errMsg },
                    timestamp: Date.now(),
                  },
                  pending: false,
                }
              : e
          )
        )
        return null
      }
    },
    [session]
  )

  // Guard against React StrictMode double-invocation
  useEffect(() => {
    if (sessionCreated.current) return
    sessionCreated.current = true
    void createSession()
    return stopPolling
  }, [createSession])

  return { session, log, error, createSession, sendRequest }
}
