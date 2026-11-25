import { useState, useContext } from 'react'
import { Typography, Button, CircularProgress } from '@mui/material'
import { toast } from 'react-toastify'
import { makeStyles } from '@mui/styles'
import { WalletContext } from '../../../../WalletContext'
import { Utils } from '@bsv/sdk'

const useStyles = makeStyles(
  theme => ({
    button_grid: {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      gridGap: (theme as any).spacing(2)
    }
  }),
  { name: 'RecoveryKey' }
)

interface RecoveryKeySettingsProps {
  history: any
  onViewKey?: (key: string) => void
}

const RecoveryKeySettings: React.FC<RecoveryKeySettingsProps> = ({ onViewKey }) => {
  const { managers } = useContext(WalletContext)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [showLoading, setShowLoading] = useState(false)
  const [changeLoading, setChangeLoading] = useState(false)
  const classes = useStyles()

  const handleViewKey = async () => {
    try {
      if (recoveryKey) {
        setRecoveryKey('')
        return
      }
      setShowLoading(true)
      const walletManager = managers.walletManager
      if (!walletManager) throw new Error('Wallet is not ready.')
      const key = Utils.toBase64(await walletManager.getRecoveryKey())
      setRecoveryKey(key)
      if (onViewKey) {
        onViewKey(key)
        setRecoveryKey('')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setShowLoading(false)
    }
  }

  const handleChangeKey = async () => {
    try {
      setChangeLoading(true)
      const walletManager = managers.walletManager
      if (!walletManager) throw new Error('Wallet is not ready.')
      await walletManager.changeRecoveryKey()
      setRecoveryKey('')
      localStorage.snap = Utils.toBase64(walletManager.saveSnapshot())
      toast.dark('Recovery key changed!')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setChangeLoading(false)
    }
  }

  return (
    <>
      <Typography variant="h4" sx={{ mb: 2 }}>
        Recovery Key
      </Typography>
      <Typography variant="body1" color="textSecondary" sx={{ mb: 3 }}>
        You will need your recovery key if you ever forget your password or lose your phone.
      </Typography>
      <br />
      <div className={classes.button_grid}>
        {showLoading ? (
          <CircularProgress />
        ) : (
          <Button color="primary" onClick={handleViewKey}>
            View
          </Button>
        )}
        <div />
        {changeLoading ? (
          <CircularProgress />
        ) : (
          <Button onClick={handleChangeKey} color="primary" variant="contained">
            Change
          </Button>
        )}
      </div>
    </>
  )
}

export default RecoveryKeySettings
