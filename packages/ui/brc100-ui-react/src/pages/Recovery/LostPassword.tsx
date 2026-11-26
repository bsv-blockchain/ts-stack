import { useContext, useState, type FormEvent } from 'react'
import type { History } from 'history'
import { Box, Button, TextField, Typography } from '@mui/material'
import { makeStyles } from '@mui/styles'
import { toast } from 'react-toastify'
import { Utils } from '@bsv/sdk'
import { WalletContext } from '../../WalletContext'
import style from './style'

const useStyles = makeStyles(
  theme => {
    const { content_wrap, back_button } = style(theme)
    return { content_wrap, back_button }
  },
  { name: 'LostPassword' }
)

const RecoveryLostPassword = ({ history }: { history: History }) => {
  const { managers, useWab } = useContext(WalletContext)
  const walletManager = managers.walletManager
  const classes = useStyles()
  const [step, setStep] = useState<'recovery-key' | 'new-password'>('recovery-key')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const authenticated = walletManager?.authenticated === true
  const existingWalletVerified =
    walletManager?.authenticationFlow === 'existing-user' &&
    walletManager.authenticationMode !== 'recovery-key-and-password'

  const handleRecoveryKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!walletManager || !existingWalletVerified || authenticated || loading) return
    const previousMode = walletManager.authenticationMode
    walletManager.authenticationMode = 'presentation-key-and-recovery-key'
    setLoading(true)
    try {
      await walletManager.provideRecoveryKey(Utils.toArray(recoveryKey.trim(), 'base64'))
      if (!walletManager.authenticated) {
        toast.error('Could not open your wallet. Check your recovery key and try again.')
        return
      }
      setRecoveryKey('')
      setStep('new-password')
    } catch {
      toast.error('Could not open your wallet. Check your recovery key and try again.')
    } finally {
      walletManager.authenticationMode = previousMode
      setLoading(false)
    }
  }

  const handlePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!walletManager?.authenticated || step !== 'new-password' || loading) return
    if (password !== confirmPassword) {
      toast.error('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      await walletManager.changePassword(password)
    } catch {
      toast.error('The password change could not be confirmed. Try again.')
      return
    } finally {
      setLoading(false)
    }

    try {
      localStorage.snap = Utils.toBase64(walletManager.saveSnapshot())
    } catch {
      toast.warn('The new password works for sign-in, but this device could not save the session.')
    }
    toast.success('Password changed.')
    history.push('/dashboard/apps')
  }

  return (
    <div className={classes.content_wrap}>
      <Typography variant="h2" paragraph fontFamily="Helvetica" fontSize="2em">
        Reset Password
      </Typography>

      {authenticated && step === 'recovery-key' && (
        <>
          <Typography paragraph>
            You’re signed in. Change your password in Security settings.
          </Typography>
          <Button onClick={() => history.push('/dashboard/security')}>
            Open Security settings
          </Button>
        </>
      )}

      {!authenticated && !existingWalletVerified && (
        <>
          <Typography paragraph>
            {useWab
              ? 'Verify your current phone number on the sign-in screen. At the password step, open Account Recovery, then Lost Password. You’ll need your recovery key.'
              : 'Enter your presentation key on the sign-in screen. At the password step, open Account Recovery, then Lost Password. You’ll need your recovery key.'}
          </Typography>
          <Button onClick={() => history.push('/')}>Go to sign-in</Button>
        </>
      )}

      {!authenticated && existingWalletVerified && (
        <Box component="form" onSubmit={event => void handleRecoveryKey(event)}>
          <Typography paragraph>Enter the recovery key for your existing wallet.</Typography>
          <TextField
            value={recoveryKey}
            onChange={event => setRecoveryKey(event.target.value)}
            label="Recovery key"
            type="password"
            autoComplete="off"
            required
            fullWidth
          />
          <Button variant="contained" type="submit" disabled={loading}>
            {loading ? 'Checking recovery key…' : 'Continue'}
          </Button>
        </Box>
      )}

      {authenticated && step === 'new-password' && (
        <Box component="form" onSubmit={event => void handlePassword(event)}>
          <TextField
            value={password}
            onChange={event => setPassword(event.target.value)}
            label="New password"
            type="password"
            autoComplete="new-password"
            margin="normal"
            required
            fullWidth
          />
          <TextField
            value={confirmPassword}
            onChange={event => setConfirmPassword(event.target.value)}
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            margin="normal"
            required
            fullWidth
          />
          <Button variant="contained" type="submit" disabled={loading}>
            {loading ? 'Changing password…' : 'Change password'}
          </Button>
        </Box>
      )}

      <Button onClick={() => history.goBack()} className={classes.back_button} disabled={loading}>
        Go Back
      </Button>
    </div>
  )
}

export default RecoveryLostPassword
