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
  reason: string
  verify: VerifyPassword
  resolve: (password: string) => void
  reject: (error: Error) => void
}

const PasswordHandler: React.FC = () => {
  const { onFocusRequested, onFocusRelinquished, isFocused } =
    useContext<UserContextValue>(UserContext)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [verifying, setVerifying] = useState(false)
  const request = useRef<PasswordRequest | null>(null)
  const queue = useRef<PasswordRequest[]>([])
  const focus = useRef<Promise<boolean> | null>(null)
  const verificationInProgress = useRef(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { setPasswordRetriever } = useContext(WalletContext)

  const requestFocus = useCallback(async () => {
    try {
      if (await isFocused()) return false
      await onFocusRequested()
      return true
    } catch {
      // Focus assistance can fail while the password form remains usable.
      return false
    }
  }, [isFocused, onFocusRequested])

  const releaseFocus = useCallback(() => {
    const requested = focus.current
    if (!requested) return
    void requested
      .then(async acquired => {
        if (focus.current !== requested || request.current) return
        focus.current = null
        if (acquired) await onFocusRelinquished()
      })
      .catch(() => {
        // The password request has already settled.
      })
  }, [onFocusRelinquished])

  const showPrompt = useCallback((pending: PasswordRequest) => {
    request.current = pending
    verificationInProgress.current = false
    setVerifying(false)
    setReason(pending.reason)
    setPassword('')
    setShowPassword(false)
    setOpen(true)
  }, [])

  const retrievePassword = useCallback<PasswordRetriever>(
    (reason, verify) => {
      return new Promise<string>((resolve, reject) => {
        const pending = { reason, verify, resolve, reject }
        if (request.current) {
          queue.current.push(pending)
          return
        }
        showPrompt(pending)
        focus.current ??= requestFocus()
      })
    },
    [requestFocus, showPrompt]
  )

  useEffect(() => {
    // The wallet context exposes the React setter for function-valued state.
    const register = setPasswordRetriever as React.Dispatch<
      React.SetStateAction<PasswordRetriever | undefined>
    >
    register(() => retrievePassword)
    return () =>
      register((current: PasswordRetriever | undefined) =>
        current === retrievePassword ? undefined : current
      )
  }, [retrievePassword, setPasswordRetriever])

  useEffect(
    () => () => {
      const active = request.current
      request.current = null
      const error = new Error('Password handler closed')
      active?.reject(error)
      for (const pending of queue.current.splice(0)) pending.reject(error)
      releaseFocus()
    },
    [releaseFocus]
  )

  const closePrompt = () => {
    const next = queue.current.shift()
    if (next) {
      showPrompt(next)
      return
    }
    request.current = null
    verificationInProgress.current = false
    setVerifying(false)
    setPassword('')
    setOpen(false)
    releaseFocus()
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
