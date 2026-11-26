import { useContext, useRef, useState } from 'react'
import {
  Alert,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Divider,
  Box,
  Stack,
  Tooltip
} from '@mui/material'
import CustomDialog from '../CustomDialog'
import AppChip from '../AppChip/index'
import BasketChip from '../BasketChip/index'
import ShoppingBasketIcon from '@mui/icons-material/ShoppingBasket'
import deterministicColor from '../../utils/deterministicColor'
import { WalletContext } from '../../WalletContext'
import { UserContext } from '../../UserContext'

const BasketAccessHandler = () => {
  const { basketRequests, advanceBasketQueue, managers } = useContext(WalletContext)
  const { basketAccessModalOpen } = useContext(UserContext)

  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [decisionError, setDecisionError] = useState('')

  async function decide(granted: boolean) {
    const request = basketRequests[0]
    const manager = managers.permissionsManager
    if (submitting.current || !request || !manager) return

    submitting.current = true
    setPending(true)
    setDecisionError('')
    try {
      if (granted) await manager.grantPermission({ requestID: request.requestID })
      else await manager.denyPermission(request.requestID)
    } catch (error) {
      const action = granted ? 'save the basket access grant' : 'deny basket access'
      const detail = error instanceof Error ? error.message : String(error)
      setDecisionError(`Could not ${action}: ${detail}`)
    } finally {
      submitting.current = false
      setPending(false)
      advanceBasketQueue()
    }
  }

  const handleDeny = () => {
    void decide(false)
  }
  const handleGrant = () => {
    void decide(true)
  }

  if (!basketAccessModalOpen || !basketRequests.length) {
    return decisionError ? (
      <Alert severity="error" onClose={() => setDecisionError('')}>
        {decisionError}
      </Alert>
    ) : null
  }

  const { basket, originator, reason, renewal } = basketRequests[0]

  return (
    <CustomDialog
      open={basketAccessModalOpen}
      title={renewal ? 'Basket Access Renewal' : 'Basket Access Request'}
      onClose={handleDeny} // If the user closes via the X, treat as "deny"
      icon={<ShoppingBasketIcon fontSize="medium" />}
    >
      <DialogContent>
        {decisionError && <Alert severity="error">{decisionError}</Alert>}
        <Stack spacing={1}>
          {/* App section */}
          <AppChip size={1.5} showDomain label={originator || 'unknown'} clickable={false} />

          <Divider />

          {/* Basket section */}
          {basket ? (
            <BasketChip basketId={basket} />
          ) : (
            <Typography>Basket details unavailable</Typography>
          )}

          {/* Reason section */}
          {reason && (
            <>
              <Divider />
              <Stack
                direction="row"
                alignItems="center"
                spacing={1}
                justifyContent="space-between"
                sx={{
                  height: '3em',
                  width: '100%'
                }}
              >
                <Typography variant="body1" fontWeight="bold">
                  Reason:
                </Typography>
                <Stack px={3}>
                  <Typography variant="body1">{reason}</Typography>
                </Stack>
              </Stack>
            </>
          )}
        </Stack>
      </DialogContent>

      {/* Visual signature */}
      <Tooltip title="Unique visual signature for this request" placement="top">
        <Box
          sx={{ mb: 3, py: 0.5, background: deterministicColor(JSON.stringify(basketRequests[0])) }}
        />
      </Tooltip>

      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button disabled={pending} onClick={handleDeny} variant="outlined" color="inherit">
          Deny
        </Button>
        <Button disabled={pending} onClick={handleGrant} variant="contained" color="primary">
          Grant Access
        </Button>
      </DialogActions>
    </CustomDialog>
  )
}

export default BasketAccessHandler
