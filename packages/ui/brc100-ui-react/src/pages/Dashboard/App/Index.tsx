/* ------------------------------------------------------------------
 * Apps.tsx — clean, performant version
 * ------------------------------------------------------------------ */

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Grid, Typography, IconButton } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { useLocation } from 'react-router-dom'
import { History } from 'history'

import { WalletContext } from '../../../WalletContext'
import { Utils, type WalletAction } from '@bsv/sdk'
import { toast } from 'react-toastify'
import { DEFAULT_APP_ICON } from '../../../constants/popularApps'
import PageHeader from '../../../components/PageHeader'
import RecentActions from '../../../components/RecentActions'
import AccessAtAGlance from '../../../components/AccessAtAGlance'
import fetchAndCacheAppData from '../../../utils/fetchAndCacheAppData'
import { openUrl } from '../../../utils/openUrl'

/* ------------------------------------------------------------------
 *  Constants & helpers
 * ------------------------------------------------------------------ */

const LIMIT = 10
const CACHE_CAPACITY = 25 // max # of apps kept in RAM

/** Simple LRU cache for per-app pages */
class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity = 50) {}

  get(key: K): V | undefined {
    const item = this.map.get(key)
    if (!item) return undefined
    // bump to most-recent
    this.map.delete(key)
    this.map.set(key, item)
    return item
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      // delete least-recent
      const first = this.map.keys().next()
      if (!first.done) this.map.delete(first.value)
    }
  }
}
const APP_PAGE_CACHE = new LruCache<
  string,
  { actions: TransformedWalletAction[]; totalActions: number }
>(CACHE_CAPACITY)

/** Transform raw actions for UI */
interface TransformedWalletAction extends WalletAction {
  amount: number
  fees?: number
}
const transformActions = (actions: WalletAction[]): TransformedWalletAction[] =>
  actions.map(a => {
    const inputSum = (a.inputs ?? []).reduce((s, i) => s + Number(i.sourceSatoshis), 0)
    const outputSum = (a.outputs ?? []).reduce((s, o) => s + Number(o.satoshis), 0)

    return {
      ...a,
      amount: a.satoshis,
      fees: inputSum - outputSum || undefined
    }
  })

/* ------------------------------------------------------------------
 *  Router state
 * ------------------------------------------------------------------ */
interface LocationState {
  domain?: string
  appName?: string
  iconImageUrl?: string
}

interface AppsProps {
  history: History
}

interface AppDetailsProps extends AppsProps {
  appDomain: string
  locationState: LocationState | undefined
  cacheKey: string | undefined
}

function getStoredSelection(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

const App: React.FC<AppsProps> = ({ history }) => {
  const { state } = useLocation<LocationState>()
  const { activeProfile } = useContext(WalletContext)
  const appDomain = state?.domain || getStoredSelection('lastAppDomain') || 'unknown.com'
  const scope = activeProfile && Utils.toBase64(activeProfile.id)
  const partition = JSON.stringify([scope, appDomain])

  return (
    <AppDetails
      key={partition}
      history={history}
      appDomain={appDomain}
      locationState={state}
      cacheKey={scope ? `profileAppActions_${partition}` : undefined}
    />
  )
}

/* ------------------------------------------------------------------
 *  Component
 * ------------------------------------------------------------------ */
const AppDetails: React.FC<AppDetailsProps> = ({ history, appDomain, locationState, cacheKey }) => {
  const { managers, adminOriginator } = useContext(WalletContext)
  const permissionsManager = managers?.permissionsManager

  /* ---------- Local state --------------------------------------- */
  const [appName, setAppName] = useState(
    () => locationState?.appName || getStoredSelection('lastAppName') || appDomain
  )
  const [appIcon, setAppIcon] = useState(
    () => locationState?.iconImageUrl || getStoredSelection('lastAppIcon') || DEFAULT_APP_ICON
  )

  const [appActions, setAppActions] = useState<TransformedWalletAction[]>([])
  const [page, setPage] = useState(0)
  const [isFetching, setIsFetching] = useState(false)
  const [allActionsShown, setAllActionsShown] = useState(false)
  const [copied, setCopied] = useState(false)

  /* ---------- Refs to avoid stale closures ---------------------- */
  const abortRef = useRef<AbortController | null>(null)

  /* ---------- Derived values ------------------------------------ */
  const url = useMemo(
    () => (appDomain.startsWith('http') ? appDomain : `https://${appDomain}`),
    [appDomain]
  )

  /* ---------- Cache hydration (localStorage) -------------------- */
  useEffect(() => {
    if (!cacheKey || !permissionsManager || !adminOriginator) return
    const memory = APP_PAGE_CACHE.get(cacheKey)
    if (memory) {
      setAppActions(memory.actions)
      setPage(Math.max(0, Math.ceil(memory.actions.length / LIMIT) - 1))
      setAllActionsShown(memory.actions.length >= memory.totalActions)
      return
    }
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached) as {
          totalTransactions: number
          transactions: WalletAction[]
        }
        const actions = transformActions(parsed.transactions)
        APP_PAGE_CACHE.set(cacheKey, { actions, totalActions: parsed.totalTransactions })
        setAppActions(actions)
        setAllActionsShown(actions.length >= parsed.totalTransactions)
      }
    } catch {
      // The action list can still be requested from the wallet.
    }
  }, [adminOriginator, cacheKey, permissionsManager])

  /* ---------- Persist router state ------------------------------ */
  useEffect(() => {
    try {
      sessionStorage.setItem('lastAppDomain', appDomain)
      sessionStorage.setItem('lastAppName', appName)
      sessionStorage.setItem('lastAppIcon', appIcon)
    } catch {
      // Route state remains available when session storage is disabled.
    }
  }, [appDomain, appName, appIcon])

  /* ---------- Clipboard helper ---------------------------------- */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    } catch {
      toast.error('Could not copy the app address.')
    }
  }

  /* ---------- Core: fetch a page of actions --------------------- */
  const fetchPage = useCallback(
    async (pageToLoad = 0) => {
      if (!permissionsManager || !adminOriginator) return
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setIsFetching(true)

      try {
        /* Fetch page in ascending order; backend returns totalActions */
        const { actions, totalActions: total } = await permissionsManager.listActions(
          {
            labels: [`admin originator ${appDomain}`],
            labelQueryMode: 'any',
            includeLabels: true,
            includeInputs: true,
            includeOutputs: true,
            limit: LIMIT,
            offset: pageToLoad * LIMIT
          },
          adminOriginator
        )

        if (controller.signal.aborted) return
        const transformed = transformActions(actions)

        setAllActionsShown((pageToLoad + 1) * LIMIT >= total)
        setAppActions(prev => (pageToLoad === 0 ? transformed : [...prev, ...transformed]))
        setPage(pageToLoad)

        if (!cacheKey) return
        APP_PAGE_CACHE.set(cacheKey, {
          actions:
            pageToLoad === 0
              ? transformed
              : [...(APP_PAGE_CACHE.get(cacheKey)?.actions ?? []), ...transformed],
          totalActions: total
        })

        /* Cache only first page in localStorage */
        if (pageToLoad === 0) {
          try {
            localStorage.setItem(
              cacheKey,
              JSON.stringify({
                totalTransactions: total,
                transactions: actions
              })
            )
          } catch {
            // Keep the in-memory result if storage is unavailable.
          }
        }
      } catch {
        if (!controller.signal.aborted) toast.error('Could not refresh app actions.')
      } finally {
        if (!controller.signal.aborted) setIsFetching(false)
      }
    },
    [appDomain, adminOriginator, cacheKey, permissionsManager]
  )

  /* ---------- Refresh first page when the action source changes -- */
  useEffect(() => {
    void fetchPage(0)
    return () => abortRef.current?.abort()
  }, [fetchPage])

  /* ---------- Load lightweight app metadata --------------------- */
  useEffect(() => {
    if (locationState?.appName && locationState.iconImageUrl) return
    let current = true
    void fetchAndCacheAppData(
      appDomain,
      icon => {
        if (current) setAppIcon(icon)
      },
      name => {
        if (current) setAppName(name)
      },
      DEFAULT_APP_ICON
    ).catch(() => {
      // The route supplies the initial app name and icon.
    })
    return () => {
      current = false
    }
  }, [appDomain, locationState])

  /* ---------- UI props ------------------------------------------ */
  const canReadActions = Boolean(permissionsManager && adminOriginator)
  const recentActionProps = {
    loading: canReadActions && isFetching,
    appActions: canReadActions ? appActions : [],
    displayLimit: LIMIT,
    setDisplayLimit: () => {},
    setRefresh: () => {
      if (isFetching || allActionsShown) return
      void fetchPage(page + 1)
    },
    allActionsShown
  }

  /* ---------- Render -------------------------------------------- */
  return (
    <Grid container direction="column" spacing={3} sx={{ maxWidth: '100%' }}>
      {/* Header */}
      <Grid item xs={12}>
        <PageHeader
          history={history}
          title={appName}
          subheading={
            <Typography variant="caption" color="textSecondary">
              {url}
              <IconButton
                aria-label="Copy app address"
                size="small"
                onClick={() => void handleCopy()}
                disabled={copied}
              >
                {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
              </IconButton>
            </Typography>
          }
          icon={appIcon}
          buttonTitle="Launch"
          buttonIcon={<OpenInNewIcon />}
          onClick={() => void openUrl(url)}
        />
      </Grid>

      {/* Body */}
      <Grid item xs={12}>
        <Grid container spacing={3}>
          {/* Recent actions */}
          <Grid item lg={6} md={6} xs={12}>
            <RecentActions {...recentActionProps} />
          </Grid>

          {/* Access at a Glance */}
          <Grid item lg={6} md={6} xs={12}>
            <AccessAtAGlance
              originator={appDomain}
              loading={isFetching}
              setRefresh={() => void fetchPage(0)}
              history={history}
            />
          </Grid>
        </Grid>
      </Grid>
    </Grid>
  )
}

export default App
