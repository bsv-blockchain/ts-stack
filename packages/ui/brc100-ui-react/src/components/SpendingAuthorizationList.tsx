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
import { FC, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'react-toastify'
import AmountDisplay from './AmountDisplay'
import { WalletContext } from '../WalletContext'
import { PermissionToken } from '@bsv/wallet-toolbox-client'
// NOTE: rely on the same exchange-rate provider used by AmountDisplay
import { ExchangeRateContext } from './AmountDisplay/ExchangeRateContextProvider'
import AppLogo from './AppLogo'

type Props = {
  app: string
  /** Set to zero to hide the spending editor, which displays one authorization. */
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

export const SpendingAuthorizationList: FC<Props> = ({ app, limit, onEmptyList }) =>
  limit === 0 ? null : <SpendingAuthorizationEditor app={app} onEmptyList={onEmptyList} />

interface LimitInputProps {
  editingExisting: boolean
  valid: boolean
  saving: boolean
  input: string
  onInput: (value: string) => void
  onSubmit: () => void
  unitName: string
  step: number
  unitLabel: string
}

function LimitInput({
  editingExisting,
  valid,
  saving,
  input,
  onInput,
  onSubmit,
  unitName,
  step,
  unitLabel
}: Readonly<LimitInputProps>) {
  const [focused, setFocused] = useState(false)
  const editing = !editingExisting || focused || input !== ''
  const adornment = <InputAdornment position="start">{unitLabel}</InputAdornment>
  const prompt = editingExisting ? `Enter new limit in ${unitName}` : `Enter limit in ${unitName}`

  return (
    <Box
      display="flex"
      alignItems="center"
      gap={2}
      justifyContent={editingExisting ? undefined : 'center'}
    >
      <TextField
        value={input}
        onChange={event => onInput(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={editingExisting && focused ? '' : prompt}
        size="small"
        type={editing ? 'number' : 'text'}
        inputProps={editing ? { min: 0, step, 'aria-label': prompt } : { 'aria-label': prompt }}
        InputProps={editing ? { startAdornment: adornment } : undefined}
        sx={{
          width: 220,
          '& input[type=number]': { MozAppearance: 'textfield' },
          '& input[type=number]::-webkit-outer-spin-button': {
            WebkitAppearance: 'none',
            margin: 0
          },
          '& input[type=number]::-webkit-inner-spin-button': { WebkitAppearance: 'none', margin: 0 }
        }}
      />
      {input !== '' && (
        <Button
          onClick={onSubmit}
          disabled={saving || !valid}
          size="small"
          variant={editingExisting ? 'contained' : 'text'}
        >
          {saving && <CircularProgress size={16} sx={{ mr: 1 }} />}
          {saving ? 'Saving…' : 'Submit'}
        </Button>
      )}
    </Box>
  )
}

function SpendingProgress({ message }: Readonly<{ message: string }>) {
  return (
    <Box textAlign="center" pt={6}>
      <Box p={3} display="flex" justifyContent="center" alignItems="center">
        <AppLogo rotate size={50} />
      </Box>
      <Typography variant="body1" sx={{ mt: 2 }}>
        {message}
      </Typography>
    </Box>
  )
}

interface SpendingSummaryProps {
  authorizedAmount: number
  currentSpending: number
  onRevoke: () => void
  children: ReactNode
}

function SpendingSummary({
  authorizedAmount,
  currentSpending,
  onRevoke,
  children
}: Readonly<SpendingSummaryProps>) {
  const progress =
    authorizedAmount > 0
      ? Math.min(Math.max((-currentSpending / authorizedAmount) * 100, 0), 100)
      : 0
  return (
    <Box>
      <Typography variant="h2" gutterBottom>
        Monthly spending limit: <AmountDisplay showFiatAsInteger>{authorizedAmount}</AmountDisplay>
      </Typography>
      <Box mb={3}>{children}</Box>
      <Typography variant="body1" gutterBottom>
        Current spending
      </Typography>
      <LinearProgress
        variant="determinate"
        value={progress}
        sx={{ height: 8, borderRadius: 4, mb: 1 }}
      />
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="body2" color="text.secondary">
          <AmountDisplay showFiatAsInteger>{-currentSpending}</AmountDisplay> spent
        </Typography>
        <Typography variant="body2" color="text.secondary">
          <AmountDisplay showFiatAsInteger>{authorizedAmount}</AmountDisplay> limit
        </Typography>
      </Box>
      <Box mt={3} textAlign="center">
        <Button variant="outlined" color="error" onClick={onRevoke} size="small">
          Revoke
        </Button>
      </Box>
    </Box>
  )
}

function SpendingAuthorizationEditor({
  app,
  onEmptyList = handleEmptyList
}: Readonly<Omit<Props, 'limit'>>) {
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
  const [tempLimit, setTempLimit] = useState('')

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
      setTempLimit('')
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
      setTempLimit('')
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
      setTempLimit('')
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
  if (busy.list) return <SpendingProgress message="Loading spending authorizations…" />

  const submitLimit = () => {
    if (!validLimit) return
    if (authorization) void updateSpendingAuthorization()
    else void createSpendingAuthorization(newLimit)
  }
  const limitEditor = (
    <LimitInput
      editingExisting={Boolean(authorization)}
      valid={validLimit}
      saving={Boolean(busy.create || busy.renewLimit)}
      input={tempLimit}
      onInput={setTempLimit}
      onSubmit={submitLimit}
      unitName={unitName}
      step={inputStep}
      unitLabel={adornmentLabel}
    />
  )
  const openRevokeDialog = () => setDialogOpen(true)
  const closeRevokeDialog = () => setDialogOpen(false)

  return (
    <>
      <Dialog open={dialogOpen} onClose={closeRevokeDialog}>
        <DialogTitle>Revoke authorization?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You can re-authorise spending the next time you use this app.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRevokeDialog} disabled={busy.revoke}>
            Cancel
          </Button>
          <Button onClick={handleConfirmRevoke} disabled={busy.revoke}>
            {busy.revoke && <CircularProgress size={16} sx={{ mr: 1 }} />}
            {busy.revoke ? 'Revoking…' : 'Revoke'}
          </Button>
        </DialogActions>
      </Dialog>

      {busy.renewLimit && <SpendingProgress message="Updating spending authorization…" />}
      {authorization && !busy.renewLimit && (
        <SpendingSummary
          authorizedAmount={authorizedAmount}
          currentSpending={currentSpending}
          onRevoke={openRevokeDialog}
        >
          {limitEditor}
        </SpendingSummary>
      )}
      {!authorization && !busy.renewLimit && busy.waitingForAuth && (
        <SpendingProgress message="Setting up spending authorization…" />
      )}
      {!authorization && !busy.renewLimit && !busy.waitingForAuth && (
        <Box textAlign="center" pt={6}>
          <Typography variant="body1">This app must ask for permission before spending.</Typography>
          <Typography variant="body1" gutterBottom sx={{ pt: 2 }}>
            Allow this app to spend a certain amount?
          </Typography>
          {limitEditor}
        </Box>
      )}
    </>
  )
}

export default SpendingAuthorizationList
