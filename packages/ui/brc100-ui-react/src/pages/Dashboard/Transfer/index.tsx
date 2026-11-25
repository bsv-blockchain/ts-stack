// src/routes/PeerPayRoute.tsx
import React, { useCallback, useEffect, useMemo, useState, useContext, useRef } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
  Select,
  MenuItem,
  FormControl,
  CircularProgress
} from '@mui/material'
import InputAdornment from '@mui/material/InputAdornment'
import { PeerPayClient, IncomingPayment } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'
import { WalletContext } from '../../../WalletContext'
import { toast } from 'react-toastify'
import { MESSAGEBOX_HOST } from '../../../config'
import { CurrencyConverter } from '@bsv/amountinator'
import useAsyncEffect from 'use-async-effect'
import { WalletProfile } from '../../../types/WalletProfile'
import { OutlinedInput } from '@mui/material'

export type PeerPayRouteProps = {
  walletClient?: WalletClient
  defaultRecipient?: string
}

/* --------------------------- Inline: Payment Form -------------------------- */
type PaymentFormProps = {
  peerPay: PeerPayClient
  onSent?: () => void
  defaultRecipient?: string
}
function PaymentForm({ peerPay, onSent, defaultRecipient }: PaymentFormProps) {
  const { managers, activeProfile } = useContext(WalletContext)
  const [recipient, setRecipient] = useState(defaultRecipient ?? '')
  const [amount, setAmount] = useState<number>(0)
  const [sending, setSending] = useState(false)
  const [profiles, setProfiles] = useState<WalletProfile[]>([])
  const [currencySymbol, setCurrencySymbol] = useState('$')
  const currencyConverter = useMemo(() => new CurrencyConverter(), [])
  const amountRevision = useRef(0)
  const [input, setInput] = useState('')

  useAsyncEffect(async () => {
    // Note: Handle errors at a higher layer!
    await currencyConverter.initialize()
    setCurrencySymbol(currencyConverter.getCurrencySymbol())
  }, [])

  const otherProfiles = useMemo(
    () => profiles.filter(p => p.identityKey !== activeProfile?.identityKey),
    [profiles, activeProfile?.identityKey]
  )

  const handleAmountChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.target.value.replace(/[^0-9.]/g, '')
      setInput(input)
      const revision = ++amountRevision.current
      setAmount(0)
      const numericAmount = Number(input)
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) return
      const satoshis = await currencyConverter.convertToSatoshis(numericAmount)
      if (revision === amountRevision.current) setAmount(satoshis ?? 0)
    },
    [currencyConverter]
  )

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (!managers?.walletManager) return
        const list: WalletProfile[] = await managers.walletManager.listProfiles()
        if (!alive) return
        const cloned = list.map(p => ({
          id: [...p.id],
          name: String(p.name),
          createdAt: p.createdAt ?? null,
          active: !!p.active,
          identityKey: p.identityKey
        }))
        setProfiles(cloned)
      } catch (e) {
        toast.error('[PaymentForm] listProfiles error:', e as any)
      }
    })()
    return () => {
      alive = false
    }
  }, [managers])

  const canSend = recipient.trim().length > 0 && amount > 0 && !sending

  const send = async () => {
    if (!canSend) return
    try {
      setSending(true)
      await peerPay.sendLivePayment({
        recipient: recipient.trim(),
        amount
      })
      onSent?.()
      toast.success('Payment Success!')
      setInput('0')
    } catch (e) {
      toast.error('[PaymentForm] sendLivePayment error:', e as any)
      alert((e as Error)?.message ?? 'Failed to send payment')
    } finally {
      setSending(false)
    }
  }

  return (
    <Paper elevation={2} sx={{ p: 2, width: '100%' }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Transfer
      </Typography>
      <Stack spacing={2}>
        <Stack spacing={2}>
          <FormControl fullWidth>
            <Select
              label="Destination Profile"
              value={recipient || ''} // recipient is the identityKey string
              displayEmpty
              onChange={e => setRecipient(e.target.value as string)}
              renderValue={val => {
                if (!val) return ''
                const p = profiles.find(p => p.identityKey === val) // <- fix
                return p ? `${p.name} — ${p.identityKey.slice(0, 10)}` : ''
              }}
              input={<OutlinedInput notched={false} />}
            >
              {otherProfiles.map(p => (
                <MenuItem key={p.identityKey} value={p.identityKey}>
                  {p.name} — {p.identityKey.slice(0, 10)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            label="Enter Amount"
            variant="outlined"
            value={input}
            onChange={handleAmountChange}
            InputProps={{
              startAdornment: <InputAdornment position="start">{currencySymbol}</InputAdornment>
            }}
            fullWidth
          />
        </Stack>

        <Box>
          <Button variant="contained" disabled={!canSend} onClick={send}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

/* --------------------------- Inline: Payment List -------------------------- */
type PaymentListProps = {
  payments: IncomingPayment[]
  onRefresh: () => void
  peerPay: PeerPayClient
}

function PaymentList({ payments, onRefresh, peerPay }: PaymentListProps) {
  // Track loading per messageId so buttons aren't linked
  const [loadingById, setLoadingById] = useState<Record<string, boolean>>({})

  const setLoadingFor = (id: string, on: boolean) => {
    setLoadingById(prev => {
      if (on) return { ...prev, [id]: true }
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const acceptWithRetry = async (p: IncomingPayment) => {
    const id = String(p.messageId)
    setLoadingFor(id, true)
    try {
      await peerPay.acceptPayment(p)
      return true
    } catch (e1) {
      toast.error('[PaymentList] acceptPayment raw failed → refetching by id', e1 as any)
      try {
        const list = await peerPay.listIncomingPayments(MESSAGEBOX_HOST)
        const fresh = list.find(x => String(x.messageId) === id)
        if (!fresh) throw new Error('Payment not found on refresh')
        await peerPay.acceptPayment(fresh)
        return true
      } catch (e2) {
        toast.error('[PaymentList] acceptPayment refresh retry failed', e2 as any)
        return false
      } finally {
        setLoadingFor(id, false)
      }
    } finally {
      // Ensure we clear loading even on the success path
      setLoadingFor(id, false)
    }
  }

  const accept = async (p: IncomingPayment) => {
    try {
      const ok = await acceptWithRetry(p)
      if (!ok) throw new Error('Accept failed')
    } catch (e) {
      toast.error('[PaymentList] acceptPayment error (final):', e as any)
      alert((e as Error)?.message ?? 'Failed to accept payment')
    } finally {
      onRefresh()
    }
  }

  return (
    <Paper elevation={2} sx={{ p: 2, width: '100%' }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="h6">Pending Transfer</Typography>
        <Button onClick={onRefresh}>Refresh</Button>
      </Box>

      {payments.length === 0 ? (
        <Typography color="text.secondary">No pending transfers.</Typography>
      ) : (
        <List sx={{ width: '100%' }}>
          {payments.map(p => {
            const id = String(p.messageId)
            const isLoading = !!loadingById[id]
            return (
              <React.Fragment key={id}>
                <ListItem
                  secondaryAction={
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        variant="contained"
                        startIcon={
                          isLoading ? <CircularProgress size={16} sx={{ color: 'black' }} /> : null
                        }
                        disabled={isLoading}
                        onClick={() => accept(p)}
                      >
                        {isLoading ? 'Receiving' : 'receive'}
                      </Button>
                    </Stack>
                  }
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip size="small" label={`${p.token.amount} sats`} />
                        <Typography fontFamily="monospace" fontSize="0.9rem">
                          {id.slice(0, 10)}…
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Typography variant="body2" color="text.secondary">
                        From: {p.sender?.slice?.(0, 14) ?? 'unknown'}…
                      </Typography>
                    }
                  />
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            )
          })}
        </List>
      )}
    </Paper>
  )
}

/* ------------------------------- Route View -------------------------------- */
export default function PeerPayRoute({ defaultRecipient }: PeerPayRouteProps) {
  const { managers, adminOriginator } = useContext(WalletContext)

  const peerPay = useMemo(() => {
    const wc = managers.permissionsManager
    if (!wc) return undefined
    return new PeerPayClient({
      walletClient: wc,
      messageBoxHost: MESSAGEBOX_HOST,
      enableLogging: true,
      originator: adminOriginator
    })
  }, [managers.permissionsManager, adminOriginator])

  const [payments, setPayments] = useState<IncomingPayment[]>([])
  const [loading, setLoading] = useState(false)
  const [snack, setSnack] = useState<{
    open: boolean
    msg: string
    severity: 'success' | 'info' | 'warning' | 'error'
  }>({
    open: false,
    msg: '',
    severity: 'info'
  })

  const fetchPayments = useCallback(async () => {
    if (!peerPay) return
    try {
      setLoading(true)
      const list = await peerPay.listIncomingPayments(MESSAGEBOX_HOST)
      setPayments(list)
    } catch (e) {
      setSnack({
        open: true,
        msg: (e as Error)?.message ?? 'Failed to load payments',
        severity: 'error'
      })
    } finally {
      setLoading(false)
    }
  }, [peerPay])

  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  useEffect(() => {
    if (!peerPay) return
    let mounted = true
    ;(async () => {
      try {
        await peerPay.initializeConnection()
        await peerPay.listenForLivePayments({
          overrideHost: MESSAGEBOX_HOST,
          onPayment: payment => {
            if (!mounted) return
            setPayments(prev => [...prev, payment])
            setSnack({ open: true, msg: 'New incoming payment', severity: 'success' })
          }
        })
      } catch {
        if (mounted)
          setSnack({
            open: true,
            msg: 'Live payment updates are unavailable.',
            severity: 'warning'
          })
      }
    })()
    return () => {
      mounted = false
    }
  }, [peerPay])

  if (!peerPay) return <Typography role="status">Wallet is not ready.</Typography>

  return (
    <Container maxWidth="sm">
      <Box sx={{ minHeight: '100vh', py: 5 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Wallet Transfer
        </Typography>

        <Stack spacing={2}>
          <PaymentForm
            peerPay={peerPay}
            onSent={fetchPayments}
            defaultRecipient={defaultRecipient}
          />

          {loading && <LinearProgress />}

          <PaymentList payments={payments} onRefresh={fetchPayments} peerPay={peerPay} />
        </Stack>

        <Snackbar
          open={snack.open}
          autoHideDuration={3500}
          onClose={() => setSnack(s => ({ ...s, open: false }))}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            severity={snack.severity}
            onClose={() => setSnack(s => ({ ...s, open: false }))}
            variant="filled"
            sx={{ width: '100%' }}
          >
            {snack.msg}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  )
}
