import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Typography,
  LinearProgress,
  Box,
  CircularProgress,
  TextField,
  InputAdornment
} from '@mui/material'
import { FC, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'react-toastify'
import AmountDisplay from './AmountDisplay'
import { WalletContext } from '../WalletContext'
import { PermissionToken } from '@bsv/wallet-toolbox-client'
// NOTE: rely on the same exchange-rate provider used by AmountDisplay
import { ExchangeRateContext } from './AmountDisplay/ExchangeRateContextProvider'
import AppLogo from './AppLogo'

type Props = {
  app: string
  limit?: number
  onEmptyList?: () => void
}

/** Local in-memory cache keyed by `app` */
const handleEmptyList = () => {}
const SPENDING_CACHE = new Map<string, { auth: PermissionToken | null; spent: number }>()

const limitUnits = {
  sats: { name: 'sats', step: 1, label: 'sats' },
  BSV: { name: 'BSV', step: 0.00000001, label: 'BSV' },
  USD: { name: 'USD', step: 0.01, label: '$' },
  EUR: { name: 'EUR', step: 0.01, label: '€' },
  GBP: { name: 'GBP', step: 0.01, label: '£' }
}

function limitCurrency(rawCurrency: string): keyof typeof limitUnits {
  if (rawCurrency === 'BSV' || rawCurrency.includes('BITCOIN')) return 'BSV'
  if (rawCurrency === 'USD' || rawCurrency === 'EUR' || rawCurrency === 'GBP') return rawCurrency
  return 'sats'
}

export const SpendingAuthorizationList: FC<Props> = ({ app, onEmptyList = handleEmptyList }) => {
  const { managers, spendingRequests, settings, activeProfile } = useContext(WalletContext)
  const rates = useContext(ExchangeRateContext)

  // --------------------------------------------------------------------------
  //   STATE
  // --------------------------------------------------------------------------
  const [authorization, setAuthorization] = useState<PermissionToken | null>(null)
  const [currentSpending, setCurrentSpending] = useState(0)
  const [authorizedAmount, setAuthorizedAmount] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState<{
    revoke?: boolean
    list?: boolean
    create?: boolean
    waitingForAuth?: boolean
    renewLimit?: boolean
  }>({ list: true })
  const [isEditingLimit, setIsEditingLimit] = useState(false)
  const [tempLimit, setTempLimit] = useState<string>('')
  const [originalLimit, setOriginalLimit] = useState<string>('')

  // --------------------------------------------------------------------------
  //   CURRENCY / UNITS (mirror AmountDisplay semantics)
  // --------------------------------------------------------------------------
  const rawCurrency: string = String(
    (settings as any)?.currency ??
      (settings as any)?.fiatCurrency ??
      (settings as any)?.displayCurrency ??
      ''
  ).toUpperCase()

  const currency = limitCurrency(rawCurrency)
  const { name: unitName, step: inputStep, label: adornmentLabel } = limitUnits[currency]
  const ratesPerUnit = {
    sats: 1,
    BSV: 1e8,
    USD: rates.satoshisPerUSD,
    EUR: rates.satoshisPerUSD / rates.eurPerUSD,
    GBP: rates.satoshisPerUSD / rates.gbpPerUSD
  }
  const satsPerUnit = ratesPerUnit[currency]
  const inputLimit = tempLimit.trim() === '' ? Number.NaN : Number(tempLimit)
  const newLimit = Math.round(inputLimit * satsPerUnit)
  const validLimit =
    inputLimit >= 0 &&
    Number.isFinite(satsPerUnit) &&
    satsPerUnit > 0 &&
    Number.isSafeInteger(newLimit)

  // --------------------------------------------------------------------------
  //   MISC
  // --------------------------------------------------------------------------
  const cacheKey = activeProfile ? JSON.stringify([app, activeProfile.id]) : undefined
  const permissionsManager = managers.permissionsManager
  const prevRqRef = useRef<number>(spendingRequests.length)

  // --------------------------------------------------------------------------
  //   HELPERS
  // --------------------------------------------------------------------------
  const refreshAuthorizations = useCallback(async () => {
    if (!cacheKey || !permissionsManager) {
      setBusy(b => ({ ...b, list: false }))
      return
    }
    // Skip cache when waiting for authorization to ensure we fetch fresh data
    if (!busy.waitingForAuth && !busy.renewLimit && SPENDING_CACHE.has(cacheKey)) {
      const { auth, spent } = SPENDING_CACHE.get(cacheKey)!
      setAuthorization(auth)
      setCurrentSpending(spent)
      setAuthorizedAmount(auth?.authorizedAmount ?? 0)
      setBusy(b => ({ ...b, list: false }))
      return
    }

    try {
      const auths = await permissionsManager.listSpendingAuthorizations({ originator: app })
      if (!auths?.length) {
        if (!busy.waitingForAuth && !busy.renewLimit) {
          setAuthorization(null)
          setCurrentSpending(0)
          setAuthorizedAmount(0)
          SPENDING_CACHE.delete(cacheKey)
          onEmptyList()
        }
      } else {
        const auth = auths[0]
        const spent = await permissionsManager.querySpentSince(auth)
        setAuthorization(auth)
        setCurrentSpending(spent)
        setAuthorizedAmount(auth.authorizedAmount ?? 0)
        SPENDING_CACHE.set(cacheKey, { auth, spent })
      }
    } catch {
      if (!busy.waitingForAuth && !busy.renewLimit) {
        onEmptyList()
      }
    } finally {
      setBusy(b => ({ ...b, list: false }))
    }
  }, [app, cacheKey, permissionsManager, onEmptyList, busy.waitingForAuth, busy.renewLimit])

  // --------------------------------------------------------------------------
  //   MUTATIONS
  // --------------------------------------------------------------------------
  const createSpendingAuthorization = async (sats: number) => {
    if (!cacheKey || !permissionsManager) return
    setBusy(b => ({ ...b, create: true }))
    try {
      await permissionsManager.ensureSpendingAuthorization({
        originator: app,
        satoshis: sats,
        reason: 'Create a spending limit',
        seekPermission: true
      })
      setBusy(b => ({ ...b, create: false, waitingForAuth: true }))
      await new Promise(res => setTimeout(res, 6000))
      SPENDING_CACHE.delete(cacheKey)
      await refreshAuthorizations()
      setIsEditingLimit(false)
    } catch (e: unknown) {
      toast.error(
        `Failed to create spending authorization: ${e instanceof Error ? e.message : 'unknown error'}`
      )
    } finally {
      setBusy(b => ({ ...b, create: false, waitingForAuth: false }))
    }
  }

  const revokeAndSetNewLimit = async (sats: number) => {
    if (!authorization || !cacheKey || !permissionsManager) return
    setBusy(b => ({ ...b, renewLimit: true }))
    try {
      await permissionsManager.revokePermission(authorization)
      SPENDING_CACHE.delete(cacheKey)
      await refreshAuthorizations()
      await new Promise(res => setTimeout(res, 2000))
      await createSpendingAuthorization(sats)
    } catch (e: unknown) {
      toast.error(
        `Failed to update spending authorization: ${e instanceof Error ? e.message : 'unknown error'}`
      )
    } finally {
      setBusy(b => ({ ...b, renewLimit: false }))
      setIsEditingLimit(false)
    }
  }

  const updateSpendingAuthorization = async () => {
    if (!cacheKey || !permissionsManager || !validLimit || busy.renewLimit) return
    setBusy(b => ({ ...b, renewLimit: true }))

    if (newLimit < authorizedAmount) {
      await revokeAndSetNewLimit(newLimit)
      return
    }
    try {
      await permissionsManager.ensureSpendingAuthorization({
        originator: app,
        satoshis: newLimit,
        reason: 'Increase spending limit',
        seekPermission: true
      })
      await new Promise(res => setTimeout(res, 2300))
      SPENDING_CACHE.delete(cacheKey)
      await refreshAuthorizations()
      setIsEditingLimit(false)
    } catch (e: unknown) {
      toast.error(
        `Failed to increase spending authorization: ${e instanceof Error ? e.message : 'unknown error'}`
      )
    } finally {
      setBusy(b => ({ ...b, renewLimit: false }))
    }
  }

  const handleConfirmRevoke = async () => {
    if (!cacheKey || !permissionsManager) return
    if (!authorization) return
    setBusy(b => ({ ...b, revoke: true }))
    try {
      await permissionsManager.revokePermission(authorization)
      setDialogOpen(false)
      SPENDING_CACHE.delete(cacheKey)
      await refreshAuthorizations()
    } catch (e: unknown) {
      toast.error(
        `Failed to revoke spending authorization: ${e instanceof Error ? e.message : 'unknown error'}`
      )
    } finally {
      setBusy(b => ({ ...b, revoke: false }))
    }
  }

  // --------------------------------------------------------------------------
  //   EFFECTS
  // --------------------------------------------------------------------------
  useEffect(() => {
    void refreshAuthorizations()
  }, [refreshAuthorizations])

  // Refresh once when the queue transitions from non-empty → empty.
  useEffect(() => {
    const finished = prevRqRef.current > 0 && spendingRequests.length === 0
    prevRqRef.current = spendingRequests.length
    if (!cacheKey || !finished) return
    const timer = setTimeout(() => {
      SPENDING_CACHE.delete(cacheKey)
      void refreshAuthorizations()
    }, 500)
    return () => clearTimeout(timer)
  }, [spendingRequests, cacheKey, refreshAuthorizations])

  // --------------------------------------------------------------------------
  //   RENDER
  // --------------------------------------------------------------------------
  if (busy.list) {
    return (
      <Box textAlign="center" pt={6}>
        <Box p={3} display="flex" justifyContent="center" alignItems="center">
          <AppLogo rotate size={50} />
        </Box>
        <Typography variant="body1" sx={{ mt: 2 }}>
          Loading spending authorizations…
        </Typography>
      </Box>
    )
  }

  return (
    <>
      {/* revoke-confirmation dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Revoke authorization?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You can re-authorise spending the next time you use this app.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={busy.revoke}>
            Cancel
          </Button>
          <Button onClick={handleConfirmRevoke} disabled={busy.revoke}>
            {busy.revoke ? (
              <>
                <CircularProgress size={16} sx={{ mr: 1 }} />
                Revoking…
              </>
            ) : (
              'Revoke'
            )}
          </Button>
        </DialogActions>
      </Dialog>

      {/* authorised state ---------------------------------------------------- */}
      {authorization || busy.renewLimit ? (
        <Box>
          {busy.renewLimit ? (
            <Box textAlign="center" pt={6}>
              <Box p={3} display="flex" justifyContent="center" alignItems="center">
                <AppLogo rotate size={50} />
              </Box>
              <Typography variant="body1" sx={{ mt: 2 }}>
                Updating spending authorization…
              </Typography>
            </Box>
          ) : (
            <>
              <Typography variant="h2" gutterBottom>
                Monthly spending limit:{' '}
                <AmountDisplay showFiatAsInteger>{authorizedAmount}</AmountDisplay>
              </Typography>

              {/* Current monthly spending limit section */}
              <Box mb={3}>
                <Box display="flex" alignItems="center" gap={2}>
                  <TextField
                    value={isEditingLimit ? tempLimit : ''}
                    onChange={e => {
                      if (!isEditingLimit) {
                        setIsEditingLimit(true)
                        setOriginalLimit('') // baseline for cancel check
                      }
                      setTempLimit(e.target.value) // don't prefill with current limit
                    }}
                    onFocus={() => {
                      if (!isEditingLimit) {
                        setIsEditingLimit(true)
                        setTempLimit('') // leave empty on focus
                        setOriginalLimit('') // so blur-without-change cancels cleanly
                      }
                    }}
                    onBlur={() => {
                      if (isEditingLimit && tempLimit === originalLimit) {
                        // user didn’t type anything — cancel edit & reset
                        setIsEditingLimit(false)
                        setTempLimit('')
                        setOriginalLimit('')
                      }
                    }}
                    placeholder={isEditingLimit ? '' : `Enter new limit in ${unitName}`}
                    size="small"
                    type={isEditingLimit ? 'number' : 'text'}
                    inputProps={isEditingLimit ? { min: 0, step: inputStep } : undefined}
                    InputProps={
                      isEditingLimit
                        ? {
                            startAdornment: (
                              <InputAdornment position="start">{adornmentLabel}</InputAdornment>
                            )
                          }
                        : undefined
                    }
                    sx={{
                      width: 220,
                      '& input': { cursor: isEditingLimit ? 'text' : 'pointer' },
                      '& input[type=number]': { MozAppearance: 'textfield' },
                      '& input[type=number]::-webkit-outer-spin-button': {
                        WebkitAppearance: 'none',
                        margin: 0
                      },
                      '& input[type=number]::-webkit-inner-spin-button': {
                        WebkitAppearance: 'none',
                        margin: 0
                      }
                    }}
                  />
                  {isEditingLimit && tempLimit !== originalLimit && (
                    <Button
                      onClick={() => {
                        void updateSpendingAuthorization()
                      }}
                      disabled={busy.renewLimit || !validLimit}
                      size="small"
                      variant="contained"
                      sx={{
                        boxShadow: 3,
                        '&:hover': { boxShadow: 6 },
                        '&:active': { boxShadow: 1 }
                      }}
                    >
                      {busy.renewLimit ? (
                        <>
                          <CircularProgress size={16} sx={{ mr: 1 }} />
                          Updating…
                        </>
                      ) : (
                        'Submit'
                      )}
                    </Button>
                  )}
                </Box>
              </Box>

              {/* Current spending progress section */}
              <Box>
                <Typography variant="body1" gutterBottom>
                  Current spending
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={
                    authorizedAmount > 0
                      ? Math.min(Math.max((-currentSpending / authorizedAmount) * 100, 0), 100)
                      : 0
                  }
                  sx={{ height: 8, borderRadius: 4, mb: 1 }}
                />
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">
                    <AmountDisplay showFiatAsInteger>{currentSpending * -1}</AmountDisplay> spent
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    <AmountDisplay showFiatAsInteger>{authorizedAmount}</AmountDisplay> limit
                  </Typography>
                </Box>
              </Box>

              <Box mt={3} textAlign="center">
                <Button
                  variant="outlined"
                  color="error"
                  onClick={() => setDialogOpen(true)}
                  size="small"
                >
                  Revoke
                </Button>
              </Box>
            </>
          )}
        </Box>
      ) : (
        /* unauthorised state -------------------------------------------------- */
        <Box textAlign="center" pt={6}>
          {busy.waitingForAuth ? (
            <>
              <Box p={3} display="flex" justifyContent="center" alignItems="center">
                <AppLogo rotate size={50} />
              </Box>
              <Typography variant="body1" sx={{ mt: 2 }}>
                Setting up spending authorization…
              </Typography>
            </>
          ) : (
            <>
              <Typography variant="body1">
                This app must ask for permission before spending.
              </Typography>
              <Typography variant="body1" gutterBottom sx={{ pt: 2 }}>
                Allow this app to spend a certain amount?
              </Typography>
              <Box display="flex" alignItems="center" gap={2} justifyContent="center">
                <TextField
                  value={isEditingLimit ? tempLimit : ''}
                  onChange={e => {
                    if (!isEditingLimit) {
                      setIsEditingLimit(true)
                      setTempLimit(e.target.value)
                      setOriginalLimit('')
                    } else {
                      setTempLimit(e.target.value)
                    }
                  }}
                  onFocus={() => {
                    if (!isEditingLimit) {
                      setIsEditingLimit(true)
                      setTempLimit('')
                      setOriginalLimit('')
                    }
                  }}
                  placeholder={`Enter limit in ${unitName}`}
                  size="small"
                  type="number"
                  inputProps={{ min: 0, step: inputStep }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">{adornmentLabel}</InputAdornment>
                    )
                  }}
                  sx={{
                    width: 220,
                    '& input[type=number]': { MozAppearance: 'textfield' },
                    '& input[type=number]::-webkit-outer-spin-button': {
                      WebkitAppearance: 'none',
                      margin: 0
                    },
                    '& input[type=number]::-webkit-inner-spin-button': {
                      WebkitAppearance: 'none',
                      margin: 0
                    }
                  }}
                />
                {tempLimit && (
                  <Button
                    onClick={() => {
                      if (validLimit) void createSpendingAuthorization(newLimit)
                    }}
                    disabled={busy.create || busy.waitingForAuth || !validLimit}
                    size="small"
                  >
                    {busy.create ? (
                      <>
                        <CircularProgress size={16} sx={{ mr: 1 }} />
                        Creating…
                      </>
                    ) : (
                      'Submit'
                    )}
                  </Button>
                )}
              </Box>
            </>
          )}
        </Box>
      )}
    </>
  )
}

export default SpendingAuthorizationList
