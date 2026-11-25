import { useContext, useState, useEffect, useRef } from 'react'
import {
  DialogContent,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Box,
  Stack
} from '@mui/material'
import AmountDisplay from '../AmountDisplay/index.js'
import CustomDialog from '../CustomDialog/index.js'
import { WalletContext } from '../../WalletContext'
import AppChip from '../AppChip/index.js'
import { Services } from '@bsv/wallet-toolbox-client'
import { UserContext } from '../../UserContext.js'
import { toast } from 'react-toastify'

const services = new Services('main')

const SpendingAuthorizationHandler: React.FC = () => {
  const { managers, spendingRequests, advanceSpendingQueue } = useContext(WalletContext)

  const { spendingAuthorizationModalOpen } = useContext(UserContext)

  const [quote, setQuote] = useState<{ requestID: string; usdPerBsv: number }>()
  const [pending, setPending] = useState(false)
  const deciding = useRef(false)
  const currentRequest = spendingRequests[0]?.requestID

  async function decide(granted: boolean, singular = true, amount?: number) {
    const manager = managers.permissionsManager
    if (!manager || !currentRequest || deciding.current) return

    deciding.current = true
    setPending(true)
    try {
      if (granted)
        await manager.grantPermission({ requestID: currentRequest, ephemeral: singular, amount })
      else await manager.denyPermission(currentRequest)
    } catch (error) {
      const action = granted ? 'save the spending authorization' : 'deny the spending request'
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(`Could not ${action}: ${detail}`)
    } finally {
      deciding.current = false
      setPending(false)
      advanceSpendingQueue()
    }
  }

  const determineUpgradeAmount = (previousAmountInSats: number | undefined) => {
    if (!quote || quote.requestID !== currentRequest) return undefined
    const usdPerSatoshi = quote.usdPerBsv / 100_000_000
    const previousAmountInUsd = (previousAmountInSats ?? Number.NaN) * usdPerSatoshi
    const tier = [5, 10, 20].find(amount => previousAmountInUsd <= amount) ?? 50
    const satoshis = Math.round(tier / usdPerSatoshi)
    return Number.isSafeInteger(satoshis) && satoshis > 0 ? satoshis : undefined
  }

  useEffect(() => {
    if (!currentRequest) return
    let cancelled = false
    void services.getBsvExchangeRate().then(
      rate => {
        if (!cancelled && Number.isFinite(rate) && rate > 0)
          setQuote({ requestID: currentRequest, usdPerBsv: rate })
      },
      error => {
        if (!cancelled) console.error('Could not refresh the spending-limit exchange rate:', error)
      }
    )
    return () => {
      cancelled = true
    }
  }, [currentRequest])

  if (spendingRequests.length === 0) {
    return null
  }

  // Get the current permission request
  const currentPerm = spendingRequests[0]

  // Determine the type of request
  const isSpendingLimitIncrease = currentPerm.description === 'Increase spending limit'
  const isCreateSpendingLimit = currentPerm.description === 'Create a spending limit'
  const isLimitChange = isSpendingLimitIncrease || isCreateSpendingLimit
  const upgradeAmount = determineUpgradeAmount(currentPerm.amountPreviouslyAuthorized)

  // Determine dialog title
  const getDialogTitle = () => {
    if (isSpendingLimitIncrease) {
      return 'Spending Limit Increase'
    }
    if (isCreateSpendingLimit) {
      return 'Set Spending Limit'
    }
    return !currentPerm.renewal ? 'Spending Request' : 'Spending Check-in'
  }

  return (
    <CustomDialog open={spendingAuthorizationModalOpen} title={getDialogTitle()}>
      <DialogContent>
        <Stack alignItems="center">
          <AppChip size={2.5} label={currentPerm.originator} clickable={false} showDomain />
          <Box mt={2} />

          {isSpendingLimitIncrease && (
            // Spending limit increases
            <Box sx={{ textAlign: 'center', my: 3, width: '100%' }}>
              <Box sx={{ mb: 2 }}>This app would like to increase its spending limit to:</Box>
              <Box
                sx={{
                  fontSize: '1.5rem',
                  fontWeight: 'bold',
                  color: 'secondary.main',
                  mb: 2
                }}
              >
                <AmountDisplay showFiatAsInteger>{currentPerm.authorizationAmount}</AmountDisplay>
                /month
              </Box>
              <Box
                sx={{
                  fontSize: '0.875rem',
                  color: 'text.secondary',
                  fontStyle: 'italic'
                }}
              >
                Reason: Increase spending limit
              </Box>
            </Box>
          )}
          {isCreateSpendingLimit && (
            // New spending limits
            <Box sx={{ textAlign: 'center', my: 3, width: '100%' }}>
              <Box sx={{ mb: 2 }}>Set a monthly spending limit for this app:</Box>
              <Box
                sx={{
                  fontSize: '1.5rem',
                  fontWeight: 'bold',
                  color: 'primary.main',
                  mb: 2
                }}
              >
                <AmountDisplay showFiatAsInteger>{currentPerm.authorizationAmount}</AmountDisplay>
                /month
              </Box>
              <Box
                sx={{
                  fontSize: '0.875rem',
                  color: 'text.secondary',
                  fontStyle: 'italic'
                }}
              >
                This will allow the app to spend up to this amount each month without asking for
                permission.
              </Box>
            </Box>
          )}
          {!isLimitChange && (
            // Details for regular spending requests
            <TableContainer
              component={Paper}
              sx={{
                overflow: 'hidden',
                my: 3,
                width: '100%'
              }}
            >
              <Table
                sx={{
                  width: '100%',
                  '& th, & td': {
                    px: 3,
                    py: 1.5
                  }
                }}
                aria-label="spending details table"
                size="medium"
              >
                <TableHead>
                  <TableRow
                    sx={{
                      color: 'text.primary',
                      '& th': {
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        color: 'text.primary',
                        letterSpacing: '0.01em',
                        borderBottom: '1px solid',
                        borderColor: 'primary.light'
                      }
                    }}
                  >
                    <TableCell>Description</TableCell>
                    <TableCell align="right">Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {currentPerm.lineItems.map((item, idx) => (
                    <TableRow
                      key={`item-${idx}-${item.description || 'unnamed'}`}
                      sx={{
                        '&:last-child td, &:last-child th': {
                          border: 0
                        },
                        '&:nth-of-type(odd)': {
                          bgcolor: 'background.default'
                        },
                        transition: 'background-color 0.2s ease',
                        '&:hover': {
                          bgcolor: 'action.hover'
                        }
                      }}
                    >
                      <TableCell
                        component="th"
                        scope="row"
                        sx={{
                          fontWeight: 500,
                          color: 'text.primary'
                        }}
                      >
                        {item.description || '—'}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          fontWeight: 600,
                          color: 'secondary.main'
                        }}
                      >
                        <AmountDisplay>{item.satoshis}</AmountDisplay>
                      </TableCell>
                    </TableRow>
                  ))}
                  {/* Show total row if there are multiple items */}
                  {currentPerm.lineItems.length > 1 && (
                    <TableRow
                      sx={{
                        bgcolor: 'primary.light',
                        '& td': {
                          py: 2,
                          fontWeight: 700,
                          color: 'primary.contrastText',
                          borderTop: '1px solid',
                          borderColor: 'divider'
                        }
                      }}
                    >
                      <TableCell>Total</TableCell>
                      <TableCell align="right">
                        <AmountDisplay>{currentPerm.authorizationAmount}</AmountDisplay>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>

        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            mt: 3,
            px: 2
          }}
        >
          <Button
            variant="outlined"
            color="error"
            disabled={pending}
            onClick={() => {
              void decide(false)
            }}
            sx={{
              height: '40px'
            }}
          >
            {isSpendingLimitIncrease || isCreateSpendingLimit ? 'Cancel' : 'Deny'}
          </Button>

          {isLimitChange && (
            <Button
              variant="contained"
              color="primary"
              disabled={pending}
              onClick={() => {
                void decide(true, false, currentPerm.authorizationAmount)
              }}
              sx={{ minWidth: '120px', height: '40px' }}
            >
              {isSpendingLimitIncrease ? 'Approve Increase' : 'Set Limit'}
            </Button>
          )}
          {!isLimitChange && (
            // Original buttons for regular spending requests
            <>
              <Button
                variant="contained"
                color="secondary"
                disabled={pending || upgradeAmount === undefined}
                onClick={() => {
                  if (upgradeAmount !== undefined) void decide(true, false, upgradeAmount)
                }}
                sx={{
                  minWidth: '120px',
                  height: '40px'
                }}
              >
                {upgradeAmount === undefined ? (
                  'Spending limit rate unavailable'
                ) : (
                  <>
                    Allow up to &nbsp;
                    <AmountDisplay showFiatAsInteger>{upgradeAmount}</AmountDisplay>
                  </>
                )}
              </Button>

              <Button
                variant="contained"
                color="success"
                disabled={pending}
                onClick={() => {
                  void decide(true)
                }}
                sx={{
                  height: '40px'
                }}
              >
                Spend
              </Button>
            </>
          )}
        </Box>
      </DialogContent>
    </CustomDialog>
  )
}

export default SpendingAuthorizationHandler
