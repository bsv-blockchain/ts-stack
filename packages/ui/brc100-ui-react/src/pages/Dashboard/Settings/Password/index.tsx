import { useState, useContext } from 'react'
import type { History } from 'history'
import style from './style'
import { Typography, Button, TextField, Box } from '@mui/material'
import { makeStyles } from '@mui/styles'
import { toast } from 'react-toastify'
import { WalletContext } from '../../../../WalletContext'
import { Utils } from '@bsv/sdk'
import AppLogo from '../../../../components/AppLogo'
const useStyles = makeStyles(style, { name: 'PasswordSettings' })

const PasswordSettings = ({ history }: { history: History }) => {
  const { managers } = useContext(WalletContext)
  const classes = useStyles()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmitPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try {
      setLoading(true)
      if (password !== confirmPassword) {
        throw new Error('Passwords do not match.')
      }
      const walletManager = managers.walletManager
      if (!walletManager) throw new Error('Wallet is not ready.')
      await walletManager.changePassword(password)
      localStorage.snap = Utils.toBase64(walletManager.saveSnapshot())
      toast.dark('Password changed!')
      setPassword('')
      setConfirmPassword('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Typography variant="h4" color="textPrimary" sx={{ mb: 2 }}>
        Change Password
      </Typography>
      <Typography variant="body1" color="textSecondary" sx={{ mb: 2 }}>
        You will be prompted to enter your old password to confirm the change.
      </Typography>
      <form onSubmit={handleSubmitPassword}>
        <TextField
          style={{ marginTop: '1.5em' }}
          onChange={e => setPassword(e.target.value)}
          placeholder="New password"
          fullWidth
          type="password"
        />
        <br />
        <br />
        <TextField
          onChange={e => setConfirmPassword(e.target.value)}
          placeholder="Retype password"
          fullWidth
          type="password"
        />
        <br />
        <br />
        <div className={classes.button_grid}>
          <Button color="primary" onClick={() => history.push('/recovery/lost-password')}>
            Forgot Password?
          </Button>
          <div />
          {loading ? (
            <Box p={3} display="flex" justifyContent="center" alignItems="center">
              <AppLogo rotate size={75} />
            </Box>
          ) : (
            <Button color="primary" variant="contained" type="submit">
              Change
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

export default PasswordSettings
