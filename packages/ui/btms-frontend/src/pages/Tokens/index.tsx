// frontend/src/pages/Tokens/index.tsx

import React, { useMemo, useState, useEffect } from 'react'
import { Link, useHistory, useParams } from 'react-router-dom'
import {
  Grid,
  Typography,
  Button,
  TableContainer,
  Box,
  LinearProgress,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Container,
  Paper,
  Chip,
  IconButton,
  Tooltip,
  TablePagination,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { Img } from '@bsv/uhrp-react'
import SortIcon from '@mui/icons-material/Sort'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import SendIcon from '@mui/icons-material/Send'
import CallReceivedIcon from '@mui/icons-material/CallReceived'
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import TrendingDownIcon from '@mui/icons-material/TrendingDown'
import { IdentityCard } from '@bsv/identity-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer } from 'recharts'
import { toast } from 'react-toastify'
import useStyles from './tokens-style'
import Send from '../../components/Send'
import Receive from '../../components/Receive'
import Burn from '../../components/Burn'
import { TXIDHexString } from '@bsv/sdk'
import { btms } from '../../btms'
import { AssetView } from '../../btms/types'
import useBtmsAssets from '../../hooks/useBtmsAssets'
import useBtmsTransactions from '../../hooks/useBtmsTransactions'
import { formatBtmsError } from '../../utils/formatBtmsError'

interface TokenTransaction {
  date: string
  timestamp?: number
  amount: number
  txid: TXIDHexString
  counterparty: string
  type?: 'issue' | 'send' | 'receive' | 'burn'
  direction?: 'incoming' | 'outgoing'
  status?: string
}

type BalanceRange = '1D' | '1W' | '1M' | '1Y'

const BALANCE_RANGE_LABELS: Record<BalanceRange, string> = {
  '1D': '1 day',
  '1W': '1 week',
  '1M': '1 month',
  '1Y': '1 year'
}

const getRangeMs = (range: BalanceRange) => {
  switch (range) {
    case '1D':
      return 24 * 60 * 60 * 1000
    case '1W':
      return 7 * 24 * 60 * 60 * 1000
    case '1M':
      return 30 * 24 * 60 * 60 * 1000
    case '1Y':
      return 365 * 24 * 60 * 60 * 1000
    default:
      return 30 * 24 * 60 * 60 * 1000
  }
}

const WOC_BASE_URL = 'https://whatsonchain.com/tx/'
const SHOW_TEST_CLEAN_BAD_OUTPUTS = false

const formatDate = (tx: TokenTransaction) => {
  if (tx.timestamp) {
    return new Date(tx.timestamp).toLocaleString()
  }
  return tx.date
}

const shortTxid = (txid: string) => {
  if (!txid) return ''
  return `${txid.slice(0, 8)}...${txid.slice(-6)}`
}

const Tokens: React.FC = () => {
  const classes = useStyles()
  const history = useHistory()
  const { assetId } = useParams<{ assetId?: string }>()
  let tokenID = assetId || ''
  if (tokenID) {
    // Replace ALL underscores with dots (not just the first one)
    tokenID = tokenID.replace(/_/g, '.')
  }

  const { assets: walletTokens, loading: assetsLoading, error: assetsError, refresh: refreshAssets } = useBtmsAssets()
  const [token, setToken] = useState<AssetView | null>(null)
  const [transactions, setTransactions] = useState<TokenTransaction[]>([])
  const [error, setError] = useState(false)
  const [cleaningBadOutputs, setCleaningBadOutputs] = useState(false)
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [balanceHistory, setBalanceHistory] = useState<Array<{ date: string; balance: number; timestamp: number }>>([])
  const [balanceRange, setBalanceRange] = useState<BalanceRange>('1M')

  // Calculate balance history from transactions
  const calculateBalanceHistory = (txs: TokenTransaction[], currentBalance: number) => {
    const normalizedCurrentBalance = Number(currentBalance) || 0
    if (txs.length === 0) {
      return [{
        date: new Date().toLocaleDateString(),
        balance: normalizedCurrentBalance,
        timestamp: Date.now()
      }]
    }

    // Sort by timestamp ascending (oldest first)
    const sorted = [...txs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

    // Start from 0 and work forward through transactions
    let runningBalance = 0
    const history: Array<{ date: string; balance: number; timestamp: number }> = []

    // Work forward through transactions, applying each one
    for (const tx of sorted) {
      runningBalance += Number(tx.amount) || 0

      history.push({
        date: tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'Unknown',
        balance: runningBalance,
        timestamp: tx.timestamp || 0
      })
    }

    // Add current point if it's different from last transaction
    if (history.length > 0 && history[history.length - 1].balance !== normalizedCurrentBalance) {
      history.push({
        date: new Date().toLocaleDateString(),
        balance: normalizedCurrentBalance,
        timestamp: Date.now()
      })
    }

    return history
  }

  const refresh = async () => {
    await refreshAssets()
  }

  const handleCleanBadOutputs = async () => {
    if (cleaningBadOutputs) return
    const confirmed = window.confirm('Remove corrupted token outputs from your wallet? This cannot be undone.')
    if (!confirmed) return

    try {
      setCleaningBadOutputs(true)
      const result = await btms.relinquishBadOutputs()

      if (result.relinquished.length === 0 && result.failed.length === 0) {
        toast.info('No corrupted outputs found')
      } else {
        if (result.relinquished.length > 0) {
          toast.success(`Removed ${result.relinquished.length} corrupted output${result.relinquished.length === 1 ? '' : 's'}`)
        }
        if (result.failed.length > 0) {
          toast.error(`Failed to remove ${result.failed.length} output${result.failed.length === 1 ? '' : 's'}`)
        }
      }

      await refresh()
    } catch (err) {
      toast.error(formatBtmsError(err, 'Failed to remove corrupted outputs'))
    } finally {
      setCleaningBadOutputs(false)
    }
  }

  const { transactions: coreTransactions, loading: transactionsLoading, error: transactionsError } = useBtmsTransactions(tokenID, 100, 0)

  useEffect(() => {
    void refresh()
  }, [tokenID])

  useEffect(() => {
    if (assetsLoading) return
    const found = walletTokens.find(x => x.assetId === tokenID)
    if (!found) {
      setError(true)
      setToken(null)
      return
    }
    setError(false)
    setToken(found)
  }, [assetsLoading, tokenID, walletTokens])

  useEffect(() => {
    if (assetsError) {
      toast.error(formatBtmsError(assetsError, 'Failed to load assets'))
    }
  }, [assetsError])

  useEffect(() => {
    if (transactionsError) {
      toast.error(formatBtmsError(transactionsError, 'Failed to load transactions'))
    }
  }, [transactionsError])

  useEffect(() => {
    const sorted = [...coreTransactions].sort((a, b) => {
      const timeA = a.timestamp || 0
      const timeB = b.timestamp || 0
      return sortOrder === 'desc' ? timeB - timeA : timeA - timeB
    })
    const mapped: TokenTransaction[] = sorted.map(tx => ({
      date: tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'Unknown',
      timestamp: tx.timestamp,
      amount: tx.amount,
      txid: tx.txid,
      counterparty: tx.counterparty || 'N/A',
      type: tx.type,
      direction: tx.direction,
      status: tx.status
    }))
    setTransactions(mapped)

    if (token) {
      const history = calculateBalanceHistory(mapped, token.balance)
      setBalanceHistory(history)
    }
  }, [coreTransactions, sortOrder, token])

  const filteredBalanceHistory = useMemo(() => {
    if (balanceHistory.length === 0) return []
    const rangeMs = getRangeMs(balanceRange)
    const cutoff = Date.now() - rangeMs
    const filtered = balanceHistory.filter(point => point.timestamp >= cutoff)
    if (filtered.length > 0) return filtered
    return balanceHistory.slice(-1)
  }, [balanceHistory, balanceRange])

  if (error) {
    return (
      <div>
        <Container>
          <Grid container>
            <Grid item className={classes.back_button}>
              <Button component={Link} to="/" color="secondary">
                <ArrowBackIosNewIcon className={classes.back_icon} /> My Tokens
              </Button>
            </Grid>
          </Grid>
          <Box>
            <br />
            <br />
            <Typography align="center">Asset not found.</Typography>
          </Box>
        </Container>
      </div>
    )
  }

  if (assetsLoading || transactionsLoading || !token) {
    return (
      <div>
        <Container>
          <Grid container>
            <Grid item className={classes.back_button}>
              <Button component={Link} to="/" color="secondary">
                <ArrowBackIosNewIcon className={classes.back_icon} /> My Tokens
              </Button>
            </Grid>
          </Grid>
          <Box>
            <br />
            <br />
            <LinearProgress color="secondary" />
          </Box>
        </Container>
      </div>
    )
  }

  const tokenBalance = Number(token.balance) || 0
  const iconURL = token.iconURL

  return (
    <div>
      <Container maxWidth="lg" sx={{ pb: 8 }}>
        <Grid container alignItems="center" className={classes.back_button}>
          <Button component={Link} to="/" color="secondary">
            <ArrowBackIosNewIcon className={classes.back_icon} /> My Tokens
          </Button>
        </Grid>

        <Paper elevation={0} sx={{ p: { xs: 3, md: 4 }, mt: 2 }}>
          <Grid container spacing={4}>
            {/* Left side - Token info */}
            <Grid item xs={12} md={4}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: '12px',
                    background: 'rgba(0, 0, 0, 0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden'
                  }}
                >
                  {iconURL ? (
                    <Img src={iconURL} alt={token.name || token.assetId} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                      {(token.name || token.assetId).slice(0, 1).toUpperCase()}
                    </Typography>
                  )}
                </Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  {token.name || 'Token'}
                </Typography>
              </Box>

              <Typography variant="h3" sx={{ fontWeight: 700, mb: 1 }}>
                {tokenBalance} units
              </Typography>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2 }}>
                <Tooltip title={token.assetId}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                    {token.assetId.slice(0, 8)}...{token.assetId.slice(-8)}
                  </Typography>
                </Tooltip>
                <Tooltip title="Copy Asset ID">
                  <IconButton
                    size="small"
                    sx={{ padding: '2px' }}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(token.assetId)
                        toast.success('Asset ID copied')
                      } catch (error) {
                        toast.error('Failed to copy Asset ID')
                      }
                    }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>

              <Box sx={{ display: 'flex', gap: 1.5 }}>
                <Send assetId={token.assetId} asset={token} onReloadNeeded={refresh} />
                <Receive assetId={token.assetId} asset={token} onReloadNeeded={refresh} />
                <Burn assetId={token.assetId} asset={token} onReloadNeeded={() => history.push('/')} />
              </Box>
              {SHOW_TEST_CLEAN_BAD_OUTPUTS && (
                <Box sx={{ mt: 2 }}>
                  <Button
                    variant="outlined"
                    color="warning"
                    size="small"
                    startIcon={<DeleteSweepIcon />}
                    onClick={handleCleanBadOutputs}
                    disabled={cleaningBadOutputs}
                  >
                    {cleaningBadOutputs ? 'Cleaning...' : 'Remove corrupted outputs'}
                  </Button>
                </Box>
              )}
            </Grid>

            {/* Right side - Balance history graph */}
            <Grid item xs={12} md={8}>
              <Box sx={{ mb: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Balance history
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <ToggleButtonGroup
                    size="small"
                    value={balanceRange}
                    exclusive
                    onChange={(_, value) => value && setBalanceRange(value)}
                  >
                    <ToggleButton value="1D">1D</ToggleButton>
                    <ToggleButton value="1W">1W</ToggleButton>
                    <ToggleButton value="1M">1M</ToggleButton>
                    <ToggleButton value="1Y">1Y</ToggleButton>
                  </ToggleButtonGroup>
                  <Typography variant="caption" color="text.secondary">
                    {BALANCE_RANGE_LABELS[balanceRange]}
                  </Typography>
                </Box>
              </Box>
              {filteredBalanceHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={filteredBalanceHistory}>
                    <defs>
                      <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                    <XAxis
                      dataKey="timestamp"
                      tick={{ fontSize: 10, fill: '#666' }}
                      stroke="#bdbdbd"
                      tickLine={false}
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(value: number) => new Date(value).toLocaleDateString()}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#666' }}
                      stroke="#bdbdbd"
                      tickLine={false}
                      axisLine={false}
                      domain={[0, 'auto']}
                    />
                    <ChartTooltip
                      contentStyle={{ backgroundColor: 'white', border: '1px solid #ccc' }}
                      formatter={(value: number) => [`${value} units`, 'Balance']}
                      labelFormatter={(label: number) => new Date(label).toLocaleDateString()}
                    />
                    <Line
                      type="monotone"
                      dataKey="balance"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      dot={{ fill: '#06b6d4', strokeWidth: 2, r: 4 }}
                      activeDot={{ r: 6 }}
                      fill="url(#colorBalance)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <Box sx={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'grey.50', borderRadius: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    No transaction history available
                  </Typography>
                </Box>
              )}
            </Grid>
          </Grid>
        </Paper>

        <Grid container direction="column" sx={{ pt: 2 }}>
          <Grid item sx={{ pb: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Transactions
            </Typography>
            <ToggleButtonGroup
              value={sortOrder}
              exclusive
              onChange={(e, newOrder) => {
                if (newOrder !== null) {
                  setSortOrder(newOrder)
                  const sorted = [...transactions].sort((a, b) => {
                    const timeA = a.timestamp || 0
                    const timeB = b.timestamp || 0
                    return newOrder === 'desc' ? timeB - timeA : timeA - timeB
                  })
                  setTransactions(sorted)
                }
              }}
              size="small"
            >
              <ToggleButton value="desc">
                <SortIcon fontSize="small" sx={{ mr: 0.5 }} />
                Newest
              </ToggleButton>
              <ToggleButton value="asc">
                <SortIcon fontSize="small" sx={{ mr: 0.5, transform: 'scaleY(-1)' }} />
                Oldest
              </ToggleButton>
            </ToggleButtonGroup>
          </Grid>
          <TableContainer component={Paper} elevation={0}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell align="left">Date</TableCell>
                  <TableCell align="left">Transaction Amount</TableCell>
                  <TableCell align="left">Counterparty</TableCell>
                  <TableCell align="right">Transaction ID</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {transactions.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map((tx, i) => {
                  const isCredit = tx.amount > 0
                  const typeLabel = tx.type === 'issue' ? 'Issued'
                    : tx.type === 'send' ? 'Sent'
                      : tx.type === 'receive' ? 'Received'
                        : tx.type === 'burn' ? 'Burned'
                          : tx.direction === 'incoming' ? 'Received' : 'Sent'

                  const getTypeIcon = () => {
                    if (tx.type === 'issue') return <AddCircleOutlineIcon sx={{ fontSize: 16 }} />
                    if (tx.type === 'send') return <SendIcon sx={{ fontSize: 16 }} />
                    if (tx.type === 'receive') return <CallReceivedIcon sx={{ fontSize: 16 }} />
                    if (tx.type === 'burn') return <LocalFireDepartmentIcon sx={{ fontSize: 16 }} />
                    return tx.direction === 'incoming' ? <CallReceivedIcon sx={{ fontSize: 16 }} /> : <SendIcon sx={{ fontSize: 16 }} />
                  }

                  const txidLabel = shortTxid(tx.txid)
                  const wocUrl = `${WOC_BASE_URL}${tx.txid}`

                  return (
                    <TableRow key={i}>
                      <TableCell align="left" style={{ width: '0.1em' }}>
                        {formatDate(tx)}
                      </TableCell>
                      <TableCell align="left">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                          <Chip
                            icon={getTypeIcon()}
                            label={typeLabel}
                            size="small"
                            color={isCredit ? 'success' : (tx.type === 'send' || (tx.direction === 'outgoing' && tx.type !== 'burn')) ? 'warning' : 'error'}
                            sx={{ minWidth: 90, fontWeight: 500 }}
                          />
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {isCredit ? <TrendingUpIcon sx={{ fontSize: 18, color: 'success.main' }} /> : <TrendingDownIcon sx={{ fontSize: 18, color: 'error.main' }} />}
                            <Typography
                              sx={{
                                fontWeight: 600,
                                color: isCredit ? 'success.main' : 'error.main',
                                fontSize: '0.95rem'
                              }}
                            >
                              {isCredit ? '+' : ''}{tx.amount}
                            </Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell align="left">
                        {tx.counterparty && tx.counterparty !== 'N/A' ? (
                          <Box
                            sx={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              maxWidth: 280,
                              '& .MuiTypography-body2': {
                                color: 'text.secondary !important'
                              }
                            }}
                          >
                            <IdentityCard identityKey={tx.counterparty} />
                          </Box>
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            System
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                          <Typography
                            component="a"
                            href={wocUrl}
                            target="_blank"
                            rel="noreferrer"
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'primary.main', textDecoration: 'none' }}
                          >
                            {txidLabel}
                          </Typography>
                          <Tooltip title="Copy TXID">
                            <IconButton
                              size="small"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(tx.txid)
                                  toast.success('TXID copied')
                                } catch (error) {
                                  toast.error('Failed to copy TXID')
                                }
                              }}
                            >
                              <ContentCopyIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <TablePagination
              rowsPerPageOptions={[5, 10, 25, 50]}
              component="div"
              count={transactions.length}
              rowsPerPage={rowsPerPage}
              page={page}
              onPageChange={(e, newPage) => setPage(newPage)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(parseInt(e.target.value, 10))
                setPage(0)
              }}
            />
          </TableContainer>
        </Grid>
      </Container>
    </div>
  )
}

export default Tokens
