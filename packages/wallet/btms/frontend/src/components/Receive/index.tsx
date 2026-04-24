import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Badge,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Paper,
  Typography,
  CircularProgress,
  Box,
  Tooltip,
  IconButton
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { IdentityCard } from '@bsv/identity-react'
import { Img } from '@bsv/uhrp-react'
import { toast } from 'react-toastify'
import { btms, IncomingToken } from '../../btms'
import { AssetView } from '../../btms/types'
import { SatoshiValue } from '@bsv/sdk'
import { formatBtmsError } from '../../utils/formatBtmsError'

type ReceiveProps = {
  assetId?: string
  asset?: AssetView
  badge?: number | boolean
  incomingAmount?: SatoshiValue
  onReloadNeeded?: () => Promise<void> | void
}

const parseIncomingMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!metadata) return undefined

  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  if (typeof metadata === 'object') {
    return metadata as Record<string, unknown>
  }

  return undefined
}

const getMetadataString = (metadata: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const truncateAssetId = (assetId: string, prefix = 8, suffix = 8): string => {
  if (!assetId || assetId.length <= prefix + suffix + 3) return assetId
  return `${assetId.slice(0, prefix)}...${assetId.slice(-suffix)}`
}

const Receive: React.FC<ReceiveProps> = ({
  assetId,
  asset,
  badge = false,
  incomingAmount,
  onReloadNeeded = () => { }
}) => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [processingSender, setProcessingSender] = useState<string | null>(null)
  const [processingAction, setProcessingAction] = useState<'receive' | 'reject' | null>(null)
  const [incoming, setIncoming] = useState<IncomingToken[]>([])

  useEffect(() => {
    // kept so eslint/react-hooks remains consistent with component lifecycle expectations
  }, [])

  // -------------------------
  // 2) Load incoming payments
  // -------------------------
  const loadIncoming = useCallback(async (desiredAssetId?: string) => {
    setLoading(true)
    try {
      const msgs = await btms.listIncoming(desiredAssetId)
      const clean: IncomingToken[] = Array.isArray(msgs) ? msgs : []
      setIncoming(clean)
    } catch (err: unknown) {
      toast.error(formatBtmsError(err, 'Failed to load incoming payments'))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleOpen = async () => {
    setOpen(true)
    await loadIncoming(assetId)
  }

  const handleClose = () => setOpen(false)

  const getSenderGroupKey = (payment: IncomingToken): string => {
    return typeof payment.sender === 'string' && payment.sender.length > 0
      ? payment.sender
      : '(unknown)'
  }

  const handleReceiveAll = async () => {
    if (incoming.length === 0) return

    try {
      setLoading(true)
      for (const payment of incoming) {
        await btms.accept(payment)
      }
      await loadIncoming(assetId)
      await Promise.resolve(onReloadNeeded())
      toast.success(`Received ${incoming.length} transfer${incoming.length === 1 ? '' : 's'} of ${resolvedAssetName}`)
      setOpen(false)
    } catch (err: any) {
      toast.error(formatBtmsError(err, 'Failed to receive incoming asset'))
    } finally {
      setLoading(false)
    }
  }

  const handleReceiveBySender = async (sender: string) => {
    const senderPayments = incoming.filter(payment => getSenderGroupKey(payment) === sender)
    if (senderPayments.length === 0) return

    try {
      setLoading(true)
      setProcessingSender(sender)
      setProcessingAction('receive')

      for (const payment of senderPayments) {
        await btms.accept(payment)
      }

      await loadIncoming(assetId)
      await Promise.resolve(onReloadNeeded())
      toast.success(`Received ${senderPayments.length} transfer${senderPayments.length === 1 ? '' : 's'} from sender`)
    } catch (err: any) {
      toast.error(formatBtmsError(err, 'Failed to receive sender transfers'))
    } finally {
      setLoading(false)
      setProcessingSender(null)
      setProcessingAction(null)
    }
  }

  const handleRejectBySender = async (sender: string) => {
    const senderPayments = incoming.filter(payment => getSenderGroupKey(payment) === sender)
    if (senderPayments.length === 0 || sender === '(unknown)') return

    try {
      setLoading(true)
      setProcessingSender(sender)
      setProcessingAction('reject')

      for (const payment of senderPayments) {
        await btms.refundIncoming(payment)
      }

      await loadIncoming(assetId)
      await Promise.resolve(onReloadNeeded())
      toast.success(`Rejected ${senderPayments.length} transfer${senderPayments.length === 1 ? '' : 's'} from sender`)
    } catch (err: any) {
      toast.error(formatBtmsError(err, 'Failed to reject sender transfers'))
    } finally {
      setLoading(false)
      setProcessingSender(null)
      setProcessingAction(null)
    }
  }

  // badge logic
  const currentCount = incoming.length
  const badgeVisible =
    typeof badge === 'number' ? badge > 0 : typeof incomingAmount === 'number' ? incomingAmount > 0 : !!badge

  const resolvedAssetMetadata = useMemo(() => {
    for (const payment of incoming) {
      const parsed = parseIncomingMetadata(payment.metadata)
      if (!parsed) continue

      const name = getMetadataString(parsed, 'name')
      const description = getMetadataString(parsed, 'description')
      const iconURL = getMetadataString(parsed, 'iconURL')

      if (name || description || iconURL) {
        return { name, description, iconURL }
      }
    }

    return undefined
  }, [incoming])

  const resolvedAssetName = asset?.name ?? resolvedAssetMetadata?.name ?? assetId ?? 'Asset'
  const resolvedAssetDescription = asset?.description ?? resolvedAssetMetadata?.description
  const resolvedAssetIconURL = asset?.iconURL ?? resolvedAssetMetadata?.iconURL
  const resolvedAssetId = assetId ?? incoming[0]?.assetId ?? '(unknown)'
  const totalIncomingAmount = incoming.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)

  const incomingBySender = useMemo(() => {
    const senderMap: Record<string, { sender: string, amount: number, count: number, payments: IncomingToken[] }> = {}

    for (const payment of incoming) {
      const sender = getSenderGroupKey(payment)

      if (!senderMap[sender]) {
        senderMap[sender] = { sender, amount: 0, count: 0, payments: [] }
      }

      senderMap[sender].amount += Number(payment.amount) || 0
      senderMap[sender].count += 1
      senderMap[sender].payments.push(payment)
    }

    return Object.values(senderMap).sort((a, b) => b.amount - a.amount)
  }, [incoming])

  const hasMultipleSenders = incomingBySender.length > 1

  const copyAssetId = async () => {
    if (resolvedAssetId === '(unknown)') return
    try {
      await navigator.clipboard.writeText(resolvedAssetId)
      toast.success('Asset ID copied')
    } catch {
      toast.error('Failed to copy Asset ID')
    }
  }

  return (
    <>
      <Badge color="error" variant={badgeVisible ? 'dot' : 'standard'}>
        <Button variant="outlined" color="secondary" onClick={handleOpen} sx={{ minWidth: 100 }}>
          Receive
        </Button>
      </Badge>

      <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm" aria-labelledby="receive-dialog-title">
        <DialogTitle id="receive-dialog-title">Receive {resolvedAssetName}</DialogTitle>

        <DialogContent dividers>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
              {resolvedAssetIconURL ? (
                <Img
                  src={resolvedAssetIconURL}
                  alt={resolvedAssetName}
                  style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover' }}
                />
              ) : null}
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {resolvedAssetName}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  Asset ID:
                  <Tooltip title={resolvedAssetId}>
                    <span style={{ fontFamily: 'monospace' }}>{truncateAssetId(resolvedAssetId)}</span>
                  </Tooltip>
                  <Tooltip title="Copy Asset ID">
                    <IconButton size="small" sx={{ p: 0.25 }} onClick={() => void copyAssetId()}>
                      <ContentCopyIcon sx={{ fontSize: 12 }} />
                    </IconButton>
                  </Tooltip>
                </Typography>
              </Box>
            </Box>

            {resolvedAssetDescription && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {resolvedAssetDescription}
              </Typography>
            )}

            {loading && incoming.length === 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 3, gap: 1.5 }}>
                <CircularProgress color="secondary" size={24} />
                <Typography variant="body2" color="text.secondary">Loading incoming asset...</Typography>
              </Box>
            ) : (
              <>
                <Typography variant="body1">
                  {currentCount === 0
                    ? 'No incoming asset available to receive.'
                    : `${totalIncomingAmount} units incoming across ${currentCount} transfer${currentCount === 1 ? '' : 's'}`}
                </Typography>

                {currentCount > 0 && (
                  <Box sx={{ mt: 1.5 }}>
                    <Typography variant="caption" color="text.secondary">
                      Sent from
                    </Typography>

                    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                      {incomingBySender.map(entry => (
                        <Box key={entry.sender} sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
                          <Box sx={{ minWidth: 0 }}>
                            {entry.sender === '(unknown)' ? (
                              <Typography variant="body2">Unknown sender</Typography>
                            ) : (
                              <IdentityCard identityKey={entry.sender} />
                            )}
                          </Box>

                          <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0 }}>
                            <Button
                              size="small"
                              variant="outlined"
                              color="inherit"
                              disabled={loading || entry.sender === '(unknown)'}
                              onClick={() => void handleRejectBySender(entry.sender)}
                            >
                              {processingSender === entry.sender && processingAction === 'reject' ? 'Rejecting...' : 'Reject'}
                            </Button>
                            <Button
                              size="small"
                              variant="contained"
                              color="secondary"
                              disabled={loading}
                              onClick={() => void handleReceiveBySender(entry.sender)}
                            >
                              {processingSender === entry.sender && processingAction === 'receive' ? 'Receiving...' : 'Receive'}
                            </Button>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                )}
              </>
            )}
          </Paper>
        </DialogContent>

        <DialogActions>
          <Button onClick={handleClose}>Close</Button>
          {hasMultipleSenders && (
            <Button
              variant="contained"
              color="secondary"
              disabled={loading || currentCount === 0}
              onClick={handleReceiveAll}
            >
              {loading ? 'Receiving all...' : 'Receive all'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}

export default Receive
