import { useState, useEffect, useContext, useCallback, useRef } from 'react'
import {
  DialogActions,
  DialogContent,
  Button,
  DialogContentText,
  TextField,
  InputAdornment,
  IconButton
} from '@mui/material'
import CustomDialog from './CustomDialog'
import { UserContext, UserContextValue } from '../UserContext'
import { Visibility, VisibilityOff } from '@mui/icons-material'
import { toast } from 'react-toastify'
import { WalletContext } from '../WalletContext'

type VerifyPassword = (candidate: string) => boolean | Promise<boolean>
type PasswordRetriever = (reason: string, verify: VerifyPassword) => Promise<string>

interface PasswordRequest {
  verify: VerifyPassword
  resolve: (password: string) => void
  reject: (error: Error) => void
}

const PasswordHandler: React.FC = () => {
  const { onFocusRequested, onFocusRelinquished, isFocused } =
    useContext<UserContextValue>(UserContext)
  const [wasOriginallyFocused, setWasOriginallyFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [verifying, setVerifying] = useState(false)
  const request = useRef<PasswordRequest | null>(null)
  const verificationInProgress = useRef(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { setPasswordRetriever } = useContext(WalletContext)

  const manageFocus = useCallback(
    async (pending: PasswordRequest) => {
      try {
        const alreadyFocused = await isFocused()
        if (request.current !== pending) return
        setWasOriginallyFocused(alreadyFocused)
        if (!alreadyFocused) await onFocusRequested()
      } catch {
        // Focus assistance can fail while the password form remains usable.
      }
    },
    [isFocused, onFocusRequested]
  )

  const retrievePassword = useCallback<PasswordRetriever>(
    (reason, verify) => {
      if (request.current) {
        return Promise.reject(new Error('A password request is already open'))
      }

      return new Promise<string>((resolve, reject) => {
        const pending = { verify, resolve, reject }
        request.current = pending
        setReason(reason)
        verificationInProgress.current = false
        setVerifying(false)
        setWasOriginallyFocused(true)
        setPassword('')
        setShowPassword(false)
        setOpen(true)
        void manageFocus(pending)
      })
    },
    [manageFocus]
  )

  useEffect(() => {
    // The wallet context exposes the React setter for function-valued state.
    const register = setPasswordRetriever as React.Dispatch<
      React.SetStateAction<PasswordRetriever | undefined>
    >
    register(() => retrievePassword)
  }, [retrievePassword, setPasswordRetriever])

  const closePrompt = () => {
    request.current = null
    verificationInProgress.current = false
    setVerifying(false)
    setPassword('')
    setOpen(false)
    if (!wasOriginallyFocused) {
      void onFocusRelinquished().catch(() => {
        // The password request has already settled.
      })
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const pending = request.current
    if (!pending || verificationInProgress.current) return
    verificationInProgress.current = true
    setVerifying(true)
    try {
      const success = await pending.verify(password)
      if (request.current !== pending) return
      if (success !== true) {
        toast.error('Incorrect password')
        return
      }
      closePrompt()
      pending.resolve(password)
    } catch {
      if (request.current === pending) toast.error('Could not verify password. Try again.')
    } finally {
      if (request.current === pending) {
        verificationInProgress.current = false
        setVerifying(false)
      }
    }
  }

  const handleAbort = () => {
    const pending = request.current
    closePrompt()
    pending?.reject(new Error('User has closed password dialog'))
  }

  return (
    <CustomDialog open={open} onClose={handleAbort} title="Enter Password">
      <form onSubmit={handleSubmit}>
        <DialogContent>
          <DialogContentText>{reason}</DialogContentText>
          <br />
          <TextField
            label="Password"
            value={password}
            disabled={verifying}
            autoFocus
            fullWidth
            type={showPassword ? 'text' : 'password'}
            onChange={e => setPassword(e.target.value)}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="toggle password visibility"
                    onClick={() => setShowPassword(!showPassword)}
                    edge="end"
                    style={{ color: 'inherit' }}
                  >
                    {showPassword ? <Visibility /> : <VisibilityOff />}
                  </IconButton>
                </InputAdornment>
              )
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button color="primary" onClick={handleAbort}>
            Cancel
          </Button>
          <Button color="primary" type="submit" disabled={verifying}>
            OK
          </Button>
        </DialogActions>
      </form>
    </CustomDialog>
  )
}

export default PasswordHandler
