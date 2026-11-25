
import React, { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Grid,
  Typography,
  Button,
  LinearProgress,
  TableContainer,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Container,
  Box,
  Paper,
  Divider,
  Chip,
  Tooltip,
  IconButton
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { Img } from '@bsv/uhrp-react'
import { toast } from 'react-toastify'
import useStyles from './home-style'
import Receive from '../../components/Receive'
import Send from '../../components/Send'
import { AssetView } from '../../btms/types'
import useBtmsAssets from '../../hooks/useBtmsAssets'
import useBtmsIncoming from '../../hooks/useBtmsIncoming'
import { formatBtmsError } from '../../utils/formatBtmsError'

interface HomeProps {
  history: {
    push: (path: string) => void
  }
}

const INCOMING_REFRESH_MS = 30000

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

const Home: React.FC<HomeProps> = ({ history }) => {
  const classes = useStyles()

  const { assets: walletTokens, loading: assetsLoading, error: assetsError, refresh: refreshAssets } = useBtmsAssets()
  const {
    incoming,
    error: incomingError,
    refresh: refreshIncomingList
  } = useBtmsIncoming(undefined, { auto: false })

  const incomingByAsset = useMemo(() => {
    const countMap: Record<string, number> = {}
    for (const msg of incoming) {
      countMap[msg.assetId] = (countMap[msg.assetId] || 0) + 1
    }
    return countMap
  }, [incoming])

  const incomingAmountsByAsset = useMemo(() => {
    const amountMap: Record<string, number> = {}
    for (const msg of incoming) {
      const numericAmount = Number(msg.amount) || 0
      amountMap[msg.assetId] = (amountMap[msg.assetId] || 0) + numericAmount
    }
    return amountMap
  }, [incoming])

  const incomingMetadataByAsset = useMemo(() => {
    const metadataMap: Record<string, { metadata?: Record<string, unknown>, name?: string, description?: string, iconURL?: string }> = {}

    for (const msg of incoming) {
      if (metadataMap[msg.assetId]) continue

      const parsedMetadata = parseIncomingMetadata(msg.metadata)
      metadataMap[msg.assetId] = {
        metadata: parsedMetadata,
        name: getMetadataString(parsedMetadata, 'name'),
        description: getMetadataString(parsedMetadata, 'description'),
        iconURL: getMetadataString(parsedMetadata, 'iconURL')
      }
    }

    return metadataMap
  }, [incoming])

  const lastIncomingFetchRef = useRef<number>(0)

  const refreshIncoming = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastIncomingFetchRef.current < INCOMING_REFRESH_MS) {
      return
    }

    try {
      await refreshIncomingList()
      lastIncomingFetchRef.current = now
    } catch (err: any) {
      lastIncomingFetchRef.current = now
      toast.error(formatBtmsError(err, 'Failed to load incoming transfers'))
    }
  }

  useEffect(() => {
    void refreshIncoming(true)
  }, [])

  useEffect(() => {
    if (assetsError) {
      toast.error(formatBtmsError(assetsError, 'Error refreshing assets'))
    }
  }, [assetsError])

  useEffect(() => {
    if (incomingError) {
      toast.error(formatBtmsError(incomingError, 'Failed to load incoming transfers'))
    }
  }, [incomingError])

  // --------------------------------------------------------------
  // MERGE wallet tokens + incoming messages (STRICT, NO STALE DATA)
  // --------------------------------------------------------------
  // --------------------------------------------------------------
  // MERGE wallet tokens + incoming messages (STRICT, CORRECT TYPES)
  // --------------------------------------------------------------
  const mergedTokens: AssetView[] = useMemo(() => {
    const byId: Record<string, AssetView> = {}

    // ----------------------------------------------------------
    // 1. Normal wallet tokens (always present)
    // ----------------------------------------------------------
    for (const w of walletTokens) {
      const incomingCount = incomingByAsset[w.assetId] ?? 0
      const incomingAmount = incomingAmountsByAsset[w.assetId] ?? 0
      const incomingMetadata = incomingMetadataByAsset[w.assetId]

      const hasPendingIncoming: boolean = incomingCount > 0
      const incoming: boolean = hasPendingIncoming

      byId[w.assetId] = {
        ...w,
        name: w.name ?? incomingMetadata?.name ?? w.assetId,
        iconURL: w.iconURL ?? incomingMetadata?.iconURL,
        description: w.description ?? incomingMetadata?.description,
        hasPendingIncoming,
        incoming, // BOOLEAN (TS FIXED)
        incomingAmount // NUMBER (safe)
      }
    }

    // ----------------------------------------------------------
    // 2. Incoming for tokens NOT already in walletTokens
    // ----------------------------------------------------------
    for (const assetId of Object.keys(incomingByAsset)) {
      if (!byId[assetId]) {
        const incomingCount = incomingByAsset[assetId] ?? 0
        const incomingAmount = incomingAmountsByAsset[assetId] ?? 0
        const incomingMetadata = incomingMetadataByAsset[assetId]

        if (incomingCount <= 0) continue

        const hasPendingIncoming: boolean = true
        const incoming: boolean = true

        byId[assetId] = {
          assetId,
          name: incomingMetadata?.name ?? assetId,
          balance: 0,
          metadata: incomingMetadata?.metadata ?? {},
          iconURL: incomingMetadata?.iconURL,
          description: incomingMetadata?.description,
          hasPendingIncoming,
          incoming,
          incomingAmount
        }
      }
    }

    // ----------------------------------------------------------
    // 3. Final sorting: tokens WITH real incoming first
    // ----------------------------------------------------------
    const arr = Object.values(byId).sort((a, b) => {
      const aInc = a.incoming ? 1 : 0
      const bInc = b.incoming ? 1 : 0
      if (aInc !== bInc) return bInc - aInc
      return a.assetId.localeCompare(b.assetId)
    })

    return arr
  }, [walletTokens, incomingByAsset, incomingAmountsByAsset, incomingMetadataByAsset])

  const totalBalance = useMemo(() => {
    return mergedTokens.reduce((sum, token) => sum + (Number(token.balance) || 0), 0)
  }, [mergedTokens])

  const totalIncoming = useMemo(() => {
    return Object.values(incomingAmountsByAsset).reduce((sum, amount) => sum + (Number(amount) || 0), 0)
  }, [incomingAmountsByAsset])

  const copyAssetId = async (event: React.MouseEvent, value: string) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Asset ID copied')
    } catch {
      toast.error('Failed to copy Asset ID')
    }
  }

  return (
    <div>
      <Container maxWidth="lg" sx={{ pb: 8 }}>
        <Grid container spacing={4} className={classes.title}>
          <Grid item xs={12} md={7}>
            <Typography variant="h2" sx={{ fontWeight: 700 }}>
              BTMS Asset Vault
            </Typography>
            <Typography variant="h6" color="text.secondary" sx={{ mt: 1, maxWidth: 520 }}>
              Manage BTMS assets with instant transfers, incoming receipts, and transparent history.
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, mt: 3, flexWrap: 'wrap' }}>
              <Button component={Link} to="/mint" variant="contained" color="primary">
                Issue New Asset
              </Button>
            </Box>
          </Grid>
          <Grid item xs={12} md={5}>
            <Paper elevation={0} sx={{ p: 3, background: 'rgba(255, 255, 255, 0.8)', backdropFilter: 'blur(16px)' }}>
              <Typography variant="overline" color="text.secondary">
                Portfolio Overview
              </Typography>
              <Typography variant="h4" sx={{ mt: 1 }}>
                {totalBalance} units
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Total balance across {mergedTokens.length} assets
              </Typography>
              <Divider sx={{ my: 2 }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Chip label={`${totalIncoming} incoming`} color="secondary" size="small" />
                <Typography variant="body2" color="text.secondary">
                  Pending incoming transfers
                </Typography>
              </Box>
            </Paper>
          </Grid>
        </Grid>

        <Grid container alignItems="center" className={classes.table_title} justifyContent="space-between">
          <Grid item>
            <Typography variant="h4" sx={{ fontWeight: 700 }}>
              My Assets
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Includes both owned assets and assets waiting to be accepted.
            </Typography>
          </Grid>
        </Grid>

        <Grid container direction="column">
          <TableContainer component={Paper} elevation={0} sx={{ mt: 2 }}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell align="left" colSpan={2}>
                    Asset
                  </TableCell>
                  <TableCell align="right">
                    Balance
                  </TableCell>
                  <TableCell align="right">
                    Transfer
                  </TableCell>
                  <TableCell align="right">
                    Incoming
                  </TableCell>
                </TableRow>
              </TableHead>

              {assetsLoading ? (
                <TableBody>
                  <TableRow />
                </TableBody>
              ) : (
                <TableBody>
                  {mergedTokens.map((token, i) => {
                    const incomingCount = incomingByAsset[token.assetId] || 0
                    const incomingAmount = incomingAmountsByAsset[token.assetId] || 0

                    // Use token.balance directly - it's already set from walletTokens in mergedTokens
                    const hasWalletBalance = token.balance > 0
                    const walletBalance = token.balance

                    const hasPendingIncoming = !!token.hasPendingIncoming || incomingCount > 0

                    const displayBalance = walletBalance
                    const incomingBadge = hasPendingIncoming ? incomingCount : 0
                    const incomingAmountForRow = hasPendingIncoming ? incomingAmount : 0

                    const balanceNode = hasWalletBalance ? (
                      displayBalance
                    ) : (
                      <span style={{ opacity: 0.5 }}>{displayBalance}</span>
                    )

                    const iconURL = token.iconURL

                    return (
                      <TableRow key={i} className={classes.link}>
                        <TableCell
                          align="left"
                          style={{ cursor: 'pointer' }}
                          onClick={() => history.push(`/tokens/${token.assetId.replace('.', '_')}`)}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                            <Box
                              sx={{
                                width: 48,
                                height: 48,
                                borderRadius: '12px',
                                background: 'rgba(15, 23, 42, 0.08)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                overflow: 'hidden'
                              }}
                            >
                              {iconURL ? (
                                <Img src={iconURL} alt={token.name || token.assetId} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              ) : (
                                <Typography variant="subtitle2" color="text.secondary">
                                  {(token.name || token.assetId).slice(0, 2).toUpperCase()}
                                </Typography>
                              )}
                            </Box>
                            <Box>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                {token.name || token.assetId}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                                  <Tooltip title={token.assetId}>
                                    <span style={{ fontFamily: 'monospace' }}>{truncateAssetId(token.assetId)}</span>
                                  </Tooltip>
                                  <Tooltip title="Copy Asset ID">
                                    <IconButton
                                      size="small"
                                      sx={{ p: 0.25 }}
                                      onClick={(event) => void copyAssetId(event, token.assetId)}
                                    >
                                      <ContentCopyIcon sx={{ fontSize: 12 }} />
                                    </IconButton>
                                  </Tooltip>
                                </Box>
                              </Typography>
                              {token.description && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                  {token.description}
                                </Typography>
                              )}
                            </Box>
                          </Box>
                        </TableCell>

                        <TableCell
                          align="left"
                          style={{ cursor: 'pointer' }}
                          onClick={() => history.push(`/tokens/${token.assetId.replace('.', '_')}`)}
                        >
                          <Typography variant="body2" color="text.secondary">
                            View details
                          </Typography>
                        </TableCell>

                        <TableCell align="right">{balanceNode}</TableCell>

                        <TableCell align="right">
                          {hasWalletBalance ? (
                            <Send
                              assetId={token.assetId}
                              asset={token}
                              onReloadNeeded={async () => {
                                await refreshAssets()
                                await refreshIncoming(true)
                              }}
                            />
                          ) : (
                            <Button
                              variant="outlined"
                              size="small"
                              disabled
                              sx={{ opacity: 0.4, cursor: 'not-allowed' }}
                            >
                              Transfer
                            </Button>
                          )}
                        </TableCell>

                        {/* RECEIVE COLUMN — FIXED */}
                        {/* RECEIVE COLUMN – correct disabled style */}
                        <TableCell align="right">
                          {hasPendingIncoming ? (
                            <Receive
                              assetId={token.assetId}
                              asset={token}
                              badge={incomingBadge}
                              incomingAmount={incomingAmountForRow}
                              onReloadNeeded={async () => {
                                await refreshAssets()
                                await refreshIncoming(true)
                              }}
                            />
                          ) : (
                            <Button
                              variant="outlined"
                              size="small"
                              disabled
                              sx={{ opacity: 0.4, cursor: 'not-allowed' }}
                            >
                              —
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              )}
            </Table>
          </TableContainer>
        </Grid>

        {assetsLoading && (
          <Box sx={{ mt: 4, textAlign: 'center' }}>
            <Typography sx={{ mb: 2 }}>Loading tokens...</Typography>
            <LinearProgress color="secondary" />
          </Box>
        )}

        {!assetsLoading && mergedTokens.length === 0 && (
          <Box sx={{ mt: 4, textAlign: 'center' }}>
            <Typography sx={{ mb: 2 }}>No assets yet.</Typography>
            <Button component={Link} to="/mint" variant="outlined" color="secondary">
              + Issue Asset
            </Button>
          </Box>
        )}
      </Container>
    </div>
  )
}

export default Home
