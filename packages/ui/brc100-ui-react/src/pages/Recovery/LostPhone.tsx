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
  { name: 'RecoveryLostPhoneNumber' }
)

const RecoveryLostPhone = ({ history }: { history: History }) => {
  const { managers } = useContext(WalletContext)
  const walletManager = managers.walletManager
  const classes = useStyles()
  const [step, setStep] = useState<'recovery-key' | 'password'>('recovery-key')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const authenticated = walletManager?.authenticated === true

  const handleRecoveryKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!walletManager || authenticated || loading) return
    setLoading(true)
    const previousMode = walletManager.authenticationMode
    walletManager.authenticationMode = 'recovery-key-and-password'
    try {
      await walletManager.provideRecoveryKey(Utils.toArray(recoveryKey.trim(), 'base64'))
      setRecoveryKey('')
      setStep('password')
    } catch {
      toast.error('Could not verify your recovery key. Check it and try again.')
    } finally {
      walletManager.authenticationMode = previousMode
      setLoading(false)
    }
  }

  const handlePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!walletManager || authenticated || loading) return
    if (walletManager.authenticationFlow !== 'existing-user') {
      setStep('recovery-key')
      toast.error('Verify your recovery key before entering your wallet password.')
      return
    }

    const previousMode = walletManager.authenticationMode
    walletManager.authenticationMode = 'recovery-key-and-password'
    setLoading(true)
    try {
      await walletManager.providePassword(password)
      if (!walletManager.authenticated) {
        toast.error('Could not open your wallet. Try again.')
        return
      }
      setPassword('')
      try {
        localStorage.snap = Utils.toBase64(walletManager.saveSnapshot())
      } catch {
        toast.warn('Your wallet is open, but this device could not save the session.')
      }
    } catch {
      toast.error('Could not open your wallet. Try again.')
    } finally {
      walletManager.authenticationMode = previousMode
      setLoading(false)
    }
  }

  return (
    <div className={classes.content_wrap}>
      <Typography variant="h2" paragraph fontFamily="Helvetica" fontSize="2em">
        Recover Wallet Access
      </Typography>

      {authenticated ? (
        <>
          <Typography paragraph>
            Your wallet is open. This screen cannot change your phone number.
          </Typography>
          <Button variant="contained" onClick={() => history.push('/dashboard/apps')}>
            Continue to wallet
          </Button>
        </>
      ) : (
        <>
          <Typography paragraph>
            Use your recovery key and wallet password to open your wallet. This screen cannot change
            your phone number.
          </Typography>
          {step === 'recovery-key' ? (
            <Box component="form" onSubmit={event => void handleRecoveryKey(event)}>
              <TextField
                value={recoveryKey}
                onChange={event => setRecoveryKey(event.target.value)}
                label="Recovery key"
                type="password"
                autoComplete="off"
                required
                fullWidth
              />
              <Button variant="contained" type="submit" disabled={loading || !walletManager}>
                {loading ? 'Checking recovery key…' : 'Continue'}
              </Button>
            </Box>
          ) : (
            <Box component="form" onSubmit={event => void handlePassword(event)}>
              <TextField
                value={password}
                onChange={event => setPassword(event.target.value)}
                label="Wallet password"
                type="password"
                autoComplete="current-password"
                required
                fullWidth
              />
              <Button variant="contained" type="submit" disabled={loading || !walletManager}>
                {loading ? 'Opening wallet…' : 'Open wallet'}
              </Button>
            </Box>
          )}
        </>
      )}

      <Button onClick={() => history.goBack()} className={classes.back_button} disabled={loading}>
        Go Back
      </Button>
    </div>
  )
}

export default RecoveryLostPhone
