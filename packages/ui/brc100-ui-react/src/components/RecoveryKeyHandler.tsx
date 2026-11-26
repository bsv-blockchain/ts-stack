import { useCallback, useState, useEffect, useRef, FC, useContext } from 'react'
import {
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  FormControlLabel,
  Checkbox,
  Typography,
  useTheme,
  Box,
  IconButton,
  Grid,
  Stack
} from '@mui/material'
import CustomDialog from './CustomDialog/index'
import LockIcon from '@mui/icons-material/Lock'
import DownloadIcon from '@mui/icons-material/Download'
import { Utils } from '@bsv/sdk'
import { WalletContext } from '../WalletContext'
import CheckIcon from '@mui/icons-material/Check'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { toast } from 'react-toastify'

type SaveRecoveryKey = (key: number[]) => Promise<true>

interface RecoveryRequest {
  resolve: (saved: true) => void
  reject: (error: Error) => void
}

const RecoveryKeyHandler: FC = () => {
  const { setRecoveryKeySaver } = useContext(WalletContext)
  const [open, setOpen] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState<string>('')
  const [affirmative1, setAffirmative1] = useState(false)
  const [affirmative2, setAffirmative2] = useState(false)
  const [affirmative3, setAffirmative3] = useState(false)

  const pendingRequest = useRef<RecoveryRequest>()
  const [copied, setCopied] = useState(false)

  const handleCopy = async (data: string) => {
    try {
      await navigator.clipboard.writeText(data)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Keep the key available for manual copy if clipboard permission is denied.
      toast.error('Could not copy the recovery key')
    }
  }

  const saveRecoveryKey = useCallback<SaveRecoveryKey>(key => {
    if (pendingRequest.current)
      return Promise.reject(new Error('A recovery key backup is already open'))
    return new Promise<true>((resolve, reject) => {
      const encodedKey = Utils.toBase64(key)
      pendingRequest.current = { resolve, reject }
      setRecoveryKey(encodedKey)
      setAffirmative1(false)
      setAffirmative2(false)
      setAffirmative3(false)
      setCopied(false)
      setOpen(true)
    })
  }, [])

  useEffect(() => {
    // The wallet context exposes the React setter for this function-valued state.
    const register = setRecoveryKeySaver as React.Dispatch<
      React.SetStateAction<SaveRecoveryKey | undefined>
    >
    register(() => saveRecoveryKey)
    return () => {
      pendingRequest.current?.reject(new Error('Recovery key backup was closed'))
      pendingRequest.current = undefined
    }
  }, [saveRecoveryKey, setRecoveryKeySaver])

  const finishBackup = (saved: boolean) => {
    const request = pendingRequest.current
    pendingRequest.current = undefined
    setRecoveryKey('')
    setOpen(false)
    if (saved) request?.resolve(true)
    else request?.reject(new Error('User abandoned the backup process'))
  }

  const handleDownload = () => {
    const recoveryKeyData = `Metanet Recovery Key:\n\n${recoveryKey}\n\nSaved: ${new Date()}`
    let url: string | undefined
    let link: HTMLAnchorElement | undefined
    try {
      url = URL.createObjectURL(new Blob([recoveryKeyData], { type: 'text/plain' }))
      link = document.createElement('a')
      link.href = url
      link.download = 'Metanet Recovery Key.txt'
      document.body.appendChild(link)
      link.click()
      toast.success('Recovery key download started')
    } catch {
      // The recovery key stays visible so the user can retry or copy it.
      toast.error('Failed to download recovery key')
    } finally {
      link?.remove()
      if (url) URL.revokeObjectURL(url)
    }
  }

  const theme = useTheme()

  return (
    <CustomDialog open={open} title="Secure Access Backup and Recovery">
      <DialogContent>
        {!affirmative1 && (
          <>
            <DialogContentText
              variant="body1"
              sx={{
                mt: 3,
                mb: 1,
                color: theme.palette.getContrastText(theme.palette.background.default)
              }}
            >
              Save Your Recovery Key Now:
            </DialogContentText>
            <Grid container spacing={2} width="100%">
              <Stack
                sx={{ my: 3 }}
                direction="row"
                alignItems="center"
                justifyContent="space-between"
              >
                <Typography
                  variant="body1"
                  sx={{
                    userSelect: 'all',
                    overflow: 'hidden',
                    wordBreak: 'break-all'
                  }}
                  color={theme.palette.getContrastText(theme.palette.background.default)}
                >
                  {recoveryKey}
                </Typography>
                <Stack>
                  <IconButton
                    size="large"
                    onClick={() => {
                      void handleCopy(recoveryKey)
                    }}
                    disabled={copied}
                    sx={{ ml: 1 }}
                  >
                    {copied ? <CheckIcon /> : <ContentCopyIcon fontSize="small" />}
                  </IconButton>
                </Stack>
              </Stack>
              <Button
                variant="contained"
                color="primary"
                startIcon={<DownloadIcon />}
                onClick={handleDownload}
                fullWidth
                sx={{ p: 2 }}
              >
                Save as a File
              </Button>
            </Grid>
            <Box my={3}>
              <DialogContentText>
                Take a screenshot, email it to yourself, print it out and put it in a safe, or save
                it to secure cloud storage.
              </DialogContentText>
            </Box>
          </>
        )}
        <DialogContentText
          sx={{ color: theme.palette.getContrastText(theme.palette.background.default) }}
        >
          <FormControlLabel
            control={<Checkbox checked={affirmative1} onChange={() => setAffirmative1(x => !x)} />}
            label={'I have saved my recovery key in a secure location'}
            labelPlacement="start"
            sx={{ m: 0, p: 0 }}
          />
        </DialogContentText>
        {affirmative1 && (
          <>
            <DialogContentText variant="body1" sx={{ mt: 3, mb: 1 }}>
              Any 2 of 3 factors are required to access your data:
            </DialogContentText>
            <DialogContentText
              sx={{
                mb: 3,
                textAlign: 'center',
                fontWeight: 'bold',
                color: theme.palette.getContrastText(theme.palette.background.default)
              }}
            >
              Phone, Password, Recovery Key
            </DialogContentText>
            <DialogContentText variant="body1" sx={{ mt: 3, mb: 1 }}>
              When you lose your phone or forget your password, you must use the other factors to
              re-establish secure control. This is a perfectly normal and unavoidable fact of life.
              However -
            </DialogContentText>
            <DialogContentText>
              <Typography
                variant="body2"
                color="error"
                sx={{
                  mt: 2,
                  mb: 2,
                  fontWeight: 'bold',
                  textAlign: 'center',
                  border: '1px solid',
                  borderColor: 'error.main',
                  p: 2,
                  borderRadius: 1
                }}
              >
                Loss of more than one factor will result in TOTAL LOSS of access to all assets,
                encrypted data, and certificates.
              </Typography>
            </DialogContentText>
            <DialogContentText
              sx={{ color: theme.palette.getContrastText(theme.palette.background.default) }}
            >
              <FormControlLabel
                control={
                  <Checkbox checked={affirmative3} onChange={() => setAffirmative3(x => !x)} />
                }
                label={'I will immediately recover lost factors using the other two'}
                labelPlacement="start"
                sx={{ m: 0, p: 0 }}
              />
            </DialogContentText>
            <DialogContentText
              sx={{ color: theme.palette.getContrastText(theme.palette.background.default) }}
            >
              <FormControlLabel
                control={
                  <Checkbox checked={affirmative2} onChange={() => setAffirmative2(x => !x)} />
                }
                label={'I am solely responsible for maintaining access to my own data'}
                labelPlacement="start"
                sx={{ m: 0, p: 0 }}
              />
            </DialogContentText>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button onClick={() => finishBackup(false)} variant="text">
          Abandon
        </Button>
        <Button
          onClick={() => finishBackup(true)}
          sx={{ backgroundColor: '#006600' }}
          endIcon={<LockIcon />}
          variant="contained"
          disabled={!affirmative1 || !affirmative2 || !affirmative3}
        >
          Securely Saved
        </Button>
      </DialogActions>
    </CustomDialog>
  )
}

export default RecoveryKeyHandler
