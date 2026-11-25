import { useState, useEffect, useContext, useRef, useCallback } from 'react'
import {
  DialogContent,
  DialogActions,
  Button,
  Typography,
  TextField,
  Box,
  IconButton,
  Tooltip
} from '@mui/material'
import CustomDialog from './CustomDialog'
import { WalletContext } from '../WalletContext'
import { WalletInterface } from '@bsv/sdk'
import { toast } from 'react-toastify'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'

type WalletFunder = (
  presentationKey: number[],
  wallet: WalletInterface,
  adminOriginator: string
) => Promise<void>

interface FundingRequest {
  wallet: WalletInterface
  resolve: () => void
}

const FundingHandler: React.FC = () => {
  const { setWalletFunder } = useContext(WalletContext)
  const [open, setOpen] = useState(false)
  const [identityKey, setIdentityKey] = useState('')
  const [paymentTX, setPaymentTX] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const request = useRef<FundingRequest>()
  const submittingRef = useRef(false)

  const showFundingPrompt = useCallback<WalletFunder>(async (_, wallet, adminOriginator) => {
    if (request.current || submittingRef.current)
      throw new Error('A funding request is already open')

    submittingRef.current = true
    let publicKey: string
    try {
      const identity = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
      publicKey = identity.publicKey
    } finally {
      submittingRef.current = false
    }

    return new Promise<void>(resolve => {
      request.current = { wallet, resolve }
      setIdentityKey(publicKey)
      setPaymentTX('')
      setOpen(true)
    })
  }, [])

  useEffect(() => {
    // The wallet context exposes the React setter for function-valued state.
    const register = setWalletFunder as React.Dispatch<
      React.SetStateAction<WalletFunder | undefined>
    >
    register(() => showFundingPrompt)
  }, [setWalletFunder, showFundingPrompt])

  const handleClose = () => {
    if (submittingRef.current) return
    const pending = request.current
    request.current = undefined
    setIdentityKey('')
    setPaymentTX('')
    setOpen(false)
    // Funding is optional in wallet registration. Dismissing the prompt skips it.
    pending?.resolve()
  }

  const handleFunded = async () => {
    const pending = request.current
    if (!pending || submittingRef.current || !paymentTX.trim()) return

    submittingRef.current = true
    setSubmitting(true)
    try {
      const payment = JSON.parse(paymentTX)
      const result = await pending.wallet.internalizeAction(payment)
      if (result.accepted !== true) throw new Error('Wallet did not accept the funding transaction')
      request.current = undefined
      setIdentityKey('')
      setPaymentTX('')
      setOpen(false)
      pending.resolve()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <CustomDialog open={open} onClose={handleClose} title="Fund Your Wallet">
      <DialogContent>
        <Typography variant="body1" sx={{ wordBreak: 'break-all' }}>
          You can add satoshis now or skip this step and fund your wallet later.
        </Typography>
        <Box
          sx={{ mt: 2, display: 'flex', alignItems: 'center', bgcolor: 'background.paper', p: 1 }}
        >
          <Typography
            variant="body2"
            sx={{ flexGrow: 1, userSelect: 'all', wordBreak: 'break-all', fontFamily: 'monospace' }}
          >
            {identityKey}
          </Typography>
          <Tooltip title="Copy to clipboard">
            <IconButton
              size="small"
              onClick={() => {
                navigator.clipboard
                  .writeText(identityKey)
                  .then(() => toast.success('Identity key copied to clipboard'))
                  .catch(err => toast.error('Failed to copy: ' + err.message))
              }}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <TextField
          label="Funding Transaction"
          placeholder="Paste your internalizable transaction JSON here (Can export from WUI)."
          multiline
          fullWidth
          rows={4}
          value={paymentTX}
          disabled={submitting}
          onChange={e => setPaymentTX(e.target.value)}
          variant="outlined"
          sx={{
            mt: 2,
            '& .MuiInputBase-input': { fontFamily: 'monospace' },
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: 'rgba(0, 0, 0, 0.1)',
                borderWidth: '1px'
              },
              '&:hover fieldset': {
                borderColor: 'rgba(0, 0, 0, 0.2)'
              },
              '&.Mui-focused fieldset': {
                borderColor: 'rgba(0, 0, 0, 0.3)',
                borderWidth: '1px'
              }
            }
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Skip for now
        </Button>
        <Button
          variant="contained"
          onClick={handleFunded}
          disabled={submitting || !paymentTX.trim()}
        >
          {submitting ? 'Funding…' : 'Fund Wallet'}
        </Button>
      </DialogActions>
    </CustomDialog>
  )
}

export default FundingHandler
