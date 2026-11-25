import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Stack,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Tooltip,
  IconButton,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  RadioGroup,
  FormControlLabel,
  Radio
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { useWallet } from '../contexts/WalletContext'
import { keyedValues } from '../utils/keyedValues'
import { StorageClient, StorageIdb, Wallet, sdk } from '@bsv/wallet-toolbox-client'
import { PrivateKey } from '@bsv/sdk'

class StorageItem implements sdk.WalletStorageInfo {
  storageIdentityKey: string
  storageName: string
  storageClass: string
  endpointURL?: string
  isActive: boolean
  isBackup: boolean
  isConflicting: boolean
  isEnabled: boolean
  userId: number

  get role(): 'active (disabled)' | 'active' | 'conflicting active' | 'backup' {
    if (this.isConflicting) return 'conflicting active'
    if (!this.isEnabled && this.isActive) return 'active (disabled)'
    if (this.isActive) return 'active'
    return 'backup'
  }

  get roleColor(): 'default' | 'primary' | 'success' | 'error' | 'warning' {
    if (this.isConflicting) return 'error'
    if (!this.isEnabled && this.isActive) return 'warning'
    if (this.isActive) return 'success'
    return 'default'
  }

  constructor(store: sdk.WalletStorageInfo) {
    this.storageIdentityKey = store.storageIdentityKey
    this.storageName = store.storageName
    this.isConflicting = store.isConflicting
    this.isActive = store.isActive
    this.isBackup = store.isBackup
    this.isEnabled = store.isEnabled
    this.storageClass = store.storageClass
    this.endpointURL = store.endpointURL
    this.userId = store.userId
  }
}

interface CreateStorageInputs {
  className: 'StorageClient' | 'StorageIdb'
  endpointURL: string
}

/** Helper: copy string to clipboard */
function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(err => console.error(err))
}

/** Helper: shortens a TXID for display (e.g., first 8 + '...' + last 8) */
function shortTxid(txid: string) {
  if (txid.length <= 16) return txid
  return txid.slice(0, 8) + '...' + txid.slice(-8)
}

function DataPage() {
  const { wallet } = useWallet()

  const [stores, setStores] = useState<StorageItem[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState<string>('')

  /**************************************************
   * useEffect: load the list initially
   **************************************************/
  useEffect(() => {
    if (!wallet) return
    fetchStores()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet])

  /**************************************************
   * Fetch / list storage providers
   **************************************************/
  function fetchStores() {
    if (!wallet) return
    setLoadingList(true)
    setListError('')
    try {
      const w = wallet as Wallet
      const stores = w.storage.getStores()
      setStores(stores.map(store => new StorageItem(store)))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('getStores error:', err)
      setListError(err?.message || String(err))
    } finally {
      setLoadingList(false)
    }
  }

  /**************************************************
   * CREATE NEW STORAGE PROVIDER Modal
   **************************************************/
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createData, setCreateData] = useState<CreateStorageInputs>({
    className: 'StorageClient',
    endpointURL: ''
  })
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string>('')
  const [progLogShowDialog, setProgLogShowDialog] = useState(false)
  const [progLogComplete, setprogLogComplete] = useState(false)
  const [progLogError, setProgLogError] = useState('')
  const [progLogTitle, setProgLogTitle] = useState('Progress Log')
  const [progLogText, setProgLogText] = useState<string[]>([])
  const [progLogActiveButtonLabel, setProgLogActiveButtonLabel] = useState('Syncing...')

  /**************************************************
   * Reveal New Storage Provider dialog
   **************************************************/
  function handleOpenCreateModal() {
    setCreateModalOpen(true)
    // Reset everything
    setCreateData({
      className: 'StorageClient',
      endpointURL: ''
    })
    setCreateError('')
  }

  function handleCloseCreateModal() {
    setCreateModalOpen(false)
  }

  function progLog(s: string): string {
    const lines = s.split('\n')
    for (const line of lines) {
      setProgLogText(prev => [...prev, line])
    }
    return s
  }

  async function doCreateNewStore() {
    if (!wallet) return
    setCreateLoading(true)
    setProgLogError('')
    setProgLogShowDialog(true)
    setprogLogComplete(false)
    setProgLogTitle('Sync Progress')
    setProgLogText([])
    setProgLogActiveButtonLabel('Syncing...')
    try {
      const w = wallet as Wallet
      switch (createData.className) {
        case 'StorageClient':
          {
            const store = new StorageClient(w, createData.endpointURL)
            await store.makeAvailable()
            await w.storage.addWalletStorageProvider(store)
            await w.storage.setActive(stores[0].storageIdentityKey, progLog)
          }
          break
        case 'StorageIdb':
          {
            const options = StorageIdb.createStorageBaseOptions(w.chain)
            const store = new StorageIdb(options)
            await store.migrate(store.dbName, PrivateKey.fromRandom().toHex())
            await store.makeAvailable()
            await w.storage.addWalletStorageProvider(store)
            await w.storage.setActive(stores[0].storageIdentityKey, progLog)
          }
          break
        default:
          break
      }
      // refresh the list
      fetchStores()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('create Storage error:', err)
      setProgLogError(err?.message || String(err))
    } finally {
      setprogLogComplete(true)
      setCreateLoading(false)
      setCreateModalOpen(false)
    }
  }

  async function handleBackup() {
    if (!wallet) return
    setProgLogError('')
    setProgLogShowDialog(true)
    setprogLogComplete(false)
    setProgLogTitle('Backup Progress')
    setProgLogText([])
    setProgLogActiveButtonLabel('Backing Up Active Store...')
    try {
      const w = wallet as Wallet
      await w.storage.updateBackups(undefined, progLog)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('Backup Storage error:', err)
      setProgLogError(err?.message || String(err))
    } finally {
      setprogLogComplete(true)
      setCreateLoading(false)
      setCreateModalOpen(false)
    }
  }

  function progLogHandleDone(): void {
    setProgLogShowDialog(false)
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}

        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          mb: 2
        }}
      >
        <Typography variant="h4" gutterBottom>
          Storage Providers
        </Typography>
        {/* Action buttons on the top right */}
        <Stack direction="row" spacing={2}>
          {stores.length > 1 && (
            <Button variant="outlined" onClick={handleBackup}>
              Backup
            </Button>
          )}
          {/* Add new storage provider */}
          <Button startIcon={<AddIcon />} variant="contained" onClick={handleOpenCreateModal}>
            Storage Provider
          </Button>
        </Stack>
      </Stack>

      {/* List */}
      <Paper sx={{ p: 2, mb: 2 }}>
        {loadingList && <Typography sx={{ mt: 2 }}>Loading...</Typography>}
        {listError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {listError}
          </Alert>
        )}

        {/* Render each storage provider in an Accordion for detail expansion */}
        {stores.map((store, idx) => {
          return (
            <Accordion key={store.storageIdentityKey} sx={{ mt: 2 }}>
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls={`panel-${idx}-content`}
                id={`panel-${idx}-header`}
              >
                {/* Top (summary) row: TXID (short), description, status, satoshis */}
                <Box sx={{ width: '100%' }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{
                      alignItems: { xs: 'flex-start', sm: 'center' },
                      justifyContent: 'space-between'
                    }}
                  >
                    {/* Left side: TxID + Description */}
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                        {shortTxid(store.storageIdentityKey)}
                      </Typography>
                      {/* Copy button for TXID */}
                      <Tooltip title="Copy full Storage Identity Key">
                        <IconButton
                          size="small"
                          onClick={e => {
                            e.stopPropagation()
                            copyToClipboard(store.storageIdentityKey)
                          }}
                        >
                          <ContentCopyIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                      {store.storageName && (
                        <Typography variant="body2" sx={{ ml: 1 }}>
                          {`${store.storageName}`}
                        </Typography>
                      )}
                      <Typography variant="body1">{store.storageClass}</Typography>
                    </Stack>

                    {/* Right side: Status + Satoshis + Outgoing/Incoming indicator */}
                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                      {/* Show status as a Chip, possibly color-coded */}
                      <Chip label={store.role} color={store.roleColor} size="small" />
                    </Stack>
                  </Stack>
                </Box>
              </AccordionSummary>

              <AccordionDetails>
                <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                  <Box>
                    <Typography variant="body2">
                      Storage Identity Key: {store.storageIdentityKey}
                    </Typography>
                    <Typography variant="body2">Storage Name: {store.storageName}</Typography>
                    <Typography variant="body2">Storage Class: {store.storageClass}</Typography>
                    {store.storageClass === 'StorageClient' && (
                      <Typography variant="body2">Endpoint URL: {store.endpointURL}</Typography>
                    )}
                    <Typography variant="body2">User ID: {store.userId}</Typography>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
          )
        })}
      </Paper>

      {/** CREATE STORAGE PROVIDER MODAL */}
      <Dialog open={createModalOpen} onClose={handleCloseCreateModal} fullWidth maxWidth="lg">
        <DialogTitle>Add Storage Provider</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 1 }}>
            {/* Display any top-level error from the parent if present */}
            {createError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {createError}
              </Alert>
            )}

            {/* Basic fields */}
            <Stack spacing={2}>
              <FormControl component="fieldset">
                <RadioGroup
                  aria-label="options"
                  name="options"
                  value={createData.className}
                  onChange={e =>
                    setCreateData(prev => ({
                      ...prev,
                      className: e.target.value as 'StorageClient' | 'StorageIdb'
                    }))
                  }
                >
                  <FormControlLabel
                    value="StorageIdb"
                    control={<Radio />}
                    label="StorageIdb (IndexedDB)"
                  />
                  <FormControlLabel
                    value="StorageClient"
                    control={<Radio />}
                    label="StorageClient"
                  />
                </RadioGroup>
                {createData.className === 'StorageClient' && (
                  <TextField
                    autoFocus
                    margin="dense"
                    id="text-input"
                    label="StorageClient Endpoint URL"
                    type="text"
                    fullWidth
                    variant="outlined"
                    value={createData.endpointURL}
                    onChange={e =>
                      setCreateData(prev => ({
                        ...prev,
                        endpointURL: e.target.value
                      }))
                    }
                  />
                )}
              </FormControl>
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <>
            {createError && (
              <Alert severity="error" sx={{ mr: 2, flex: 1 }}>
                {createError}
              </Alert>
            )}
            <Button onClick={handleCloseCreateModal} disabled={createLoading}>
              Cancel
            </Button>
            <Button variant="contained" onClick={doCreateNewStore} disabled={createLoading}>
              {createLoading ? 'Adding...' : 'Add'}
            </Button>
          </>
        </DialogActions>
      </Dialog>

      {/** SHOW SYNC OR BACKUP PROGRESS MODAL */}
      <Dialog open={progLogShowDialog} aria-labelledby="progress-log-dialog-title">
        <DialogTitle id="progress-log-dialog-title">{progLogTitle}</DialogTitle>
        <DialogContent>
          <Box
            sx={{
              minWidth: 600,
              maxHeight: 400,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap', // Preserve newlines and wrap text
              fontFamily: 'monospace' // Better for log display
            }}
          >
            {progLogError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {progLogError}
              </Alert>
            )}
            {keyedValues(progLogText).map(({ key, value }) => (
              <Typography key={key} variant="body2">
                {value}
              </Typography>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={progLogHandleDone}
            variant="contained"
            color="primary"
            disabled={!progLogComplete}
          >
            {progLogComplete ? 'Done' : progLogActiveButtonLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default DataPage
