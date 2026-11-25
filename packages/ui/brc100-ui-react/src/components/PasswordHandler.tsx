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

const PasswordHandler: React.FC = () => {
  const { onFocusRequested, onFocusRelinquished, isFocused } =
    useContext<UserContextValue>(UserContext)
  const [wasOriginallyFocused, setWasOriginallyFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [test, setTest] = useState<VerifyPassword>(() => () => false)
  const [verifying, setVerifying] = useState(false)
  const requestRevision = useRef(0)
  const verificationInProgress = useRef(false)
  const [resolve, setResolve] = useState<Function>(() => {})
  const [reject, setReject] = useState<Function>(() => {})
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { setPasswordRetriever } = useContext(WalletContext)

  const manageFocus = useCallback(() => {
    isFocused().then(wasOriginallyFocused => {
      setWasOriginallyFocused(wasOriginallyFocused)
      if (!wasOriginallyFocused) {
        onFocusRequested()
      }
    })
  }, [isFocused, onFocusRequested])

  useEffect(() => {
    setPasswordRetriever((): any => {
      return (reason: string, test: VerifyPassword): Promise<string> => {
        return new Promise<string>((resolve: Function, reject: Function) => {
          setReason(() => {
            return reason
          })
          setTest(() => {
            return test
          })
          setResolve(() => {
            return resolve
          })
          setReject(() => {
            return reject
          })
          requestRevision.current++
          verificationInProgress.current = false
          setVerifying(false)
          setPassword('')
          setOpen(true)
          manageFocus()
        })
      }
    })
  }, [manageFocus, setPasswordRetriever])

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    if (verificationInProgress.current) return
    const revision = requestRevision.current
    verificationInProgress.current = true
    setVerifying(true)
    try {
      const success = await test(password)
      if (revision !== requestRevision.current) return
      if (success !== true) {
        toast.error('Incorrect password')
        return
      }
      resolve(password)
      setPassword('')
      setOpen(false)
      if (!wasOriginallyFocused) await onFocusRelinquished()
    } catch {
      if (revision === requestRevision.current) toast.error('Could not verify password. Try again.')
    } finally {
      if (revision === requestRevision.current) {
        verificationInProgress.current = false
        setVerifying(false)
      }
    }
  }

  const handleAbort = async () => {
    requestRevision.current++
    verificationInProgress.current = false
    reject(new Error('User has closed password dialog'))
    setVerifying(false)
    setPassword('')
    setOpen(false)
    if (!wasOriginallyFocused) {
      await onFocusRelinquished()
    }
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
