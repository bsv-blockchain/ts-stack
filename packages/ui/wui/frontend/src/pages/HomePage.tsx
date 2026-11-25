import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  Paper,
  FormHelperText,
  IconButton,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import AddIcon from '@mui/icons-material/Add'

import { useWallet } from '../contexts/WalletContext'
import {
  addNewConfig,
  getAllConfigs,
  removeConfig,
  updateConfig,
  WalletConfig
} from '../utils/configStorage'
import { generateRandomPrivateKey, validatePrivateKey, parseDomain } from '../utils/miscHelpers'

const knownHosts = [
  { network: 'main', name: 'Default Storage (Mainnet)', url: 'https://storage.babbage.systems' },
  { network: 'main', name: 'MOCK Mainnet Storage2', url: 'https://wallet-storage2.com' },
  { network: 'main', name: 'MOCK Mainnet Storage3', url: 'https://wallet-storage3.com' },

  {
    network: 'test',
    name: 'Default Storage (Testnet)',
    url: 'https://staging-storage.babbage.systems'
  },
  { network: 'test', name: 'MOCK Testnet Storage2', url: 'https://testnet-storage2.com' },
  { network: 'test', name: 'MOCK Testnet Storage3', url: 'https://testnet-storage3.com' }
]

function HomePage() {
  const navigate = useNavigate()
  const { pickActiveConfig } = useWallet()

  const [configs, setConfigs] = useState<WalletConfig[]>([])
  const [addingNew, setAddingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Fields for new/edit config
  const [cfgName, setCfgName] = useState('')
  const [privKeyInput, setPrivKeyInput] = useState('')
  const [networkInput, setNetworkInput] = useState<'main' | 'test'>('test')
  const [storageInput, setStorageInput] = useState('')
  const [privKeyError, setPrivKeyError] = useState('')
  const [storageError, setStorageError] = useState('')

  useEffect(() => {
    refreshConfigs()
  }, [])

  // If there's an active wallet, we do NOT automatically redirect.
  // Because we might want to let them manage configs even though one is active.
  // Only if you want to replicate old behavior:
  //   if(wallet) navigate('/actions');

  function refreshConfigs() {
    const all = getAllConfigs()
    setConfigs(all)
  }

  function startAddConfig() {
    setAddingNew(true)
    setEditingId(null)
    setCfgName('')
    setPrivKeyInput('')
    setNetworkInput('test')
    setStorageInput('')
    setPrivKeyError('')
    setStorageError('')
  }

  function startEditConfig(c: WalletConfig) {
    setEditingId(c.id)
    setAddingNew(false)

    setCfgName(c.name)
    setPrivKeyInput(c.privateKey)
    setNetworkInput(c.network)
    setStorageInput(c.storage)
    setPrivKeyError('')
    setStorageError('')
  }

  function handleSaveConfig() {
    // Validate PK
    const pkErr = validatePrivateKey(privKeyInput.trim())
    if (pkErr) {
      setPrivKeyError(pkErr)
      return
    }
    // Validate storage
    if (!storageInput.trim()) {
      setStorageError('Must provide a storage URL')
      return
    }

    try {
      new URL(storageInput.trim())
    } catch {
      setStorageError('Invalid URL format')
      return
    }

    if (!cfgName.trim()) {
      // Could do other validations
      setStorageError('Must provide a name')
      return
    }

    // Now save
    if (editingId) {
      // Update existing
      const updated = updateConfig(editingId, {
        name: cfgName.trim(),
        privateKey: privKeyInput.trim(),
        network: networkInput,
        storage: storageInput.trim()
      })
      if (!updated) {
        console.error('Error: config not found or not updated')
      }
    } else {
      // Add new
      addNewConfig(cfgName.trim(), privKeyInput.trim(), networkInput, storageInput.trim())
    }
    refreshConfigs()
    handleCloseDialog()
  }

  function handleCloseDialog() {
    setAddingNew(false)
    setEditingId(null)
  }

  function onRemoveConfig(id: string) {
    removeConfig(id)
    refreshConfigs()
  }

  async function onUseConfig(id: string) {
    // pickActiveConfig will build the wallet and set in context
    await pickActiveConfig(id)
    navigate('/actions')
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        minHeight: '100vh',
        px: 2,
        py: 4
      }}
    >
      <Paper
        sx={{
          p: 4,
          width: '100%',
          maxWidth: 600,
          display: 'flex',
          flexDirection: 'column',
          gap: 3
        }}
      >
        <Typography variant="h5" gutterBottom>
          Manage Wallet Configurations
        </Typography>

        {configs.length === 0 && (
          <Typography>No configurations saved yet. Add one below.</Typography>
        )}
        <Stack spacing={1}>
          {configs.map(c => {
            const domain = parseDomain(c.storage)
            return (
              <Box
                key={c.id}
                sx={{
                  border: '1px solid #ccc',
                  borderRadius: 1,
                  p: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 'bold' }}>
                    {c.name} (<strong>••••{c.pubKeySuffix}</strong>)
                  </Typography>
                  <Typography variant="body2">
                    {c.network.toUpperCase()} | {domain}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <IconButton onClick={() => startEditConfig(c)}>
                    <EditIcon />
                  </IconButton>
                  <IconButton onClick={() => onRemoveConfig(c.id)}>
                    <DeleteIcon />
                  </IconButton>
                  <Button variant="contained" onClick={() => onUseConfig(c.id)}>
                    Use
                  </Button>
                </Stack>
              </Box>
            )
          })}
        </Stack>

        <Box sx={{ textAlign: 'right' }}>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={startAddConfig}>
            Add New
          </Button>
        </Box>
      </Paper>

      {/* New/Edit Config Dialog */}
      {(addingNew || editingId) && (
        <Dialog open onClose={handleCloseDialog} maxWidth="sm" fullWidth>
          <DialogTitle>{editingId ? 'Edit Configuration' : 'Add New Configuration'}</DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField label="Name" value={cfgName} onChange={e => setCfgName(e.target.value)} />
            <TextField
              label="Private Key (64 hex)"
              value={privKeyInput}
              error={!!privKeyError}
              helperText={privKeyError}
              onChange={e => setPrivKeyInput(e.target.value)}
            />
            <Button variant="outlined" onClick={() => setPrivKeyInput(generateRandomPrivateKey())}>
              Generate Random Key
            </Button>
            <FormControl>
              <InputLabel>Network</InputLabel>
              <Select
                label="Network"
                value={networkInput}
                onChange={e => setNetworkInput(e.target.value === 'main' ? 'main' : 'test')}
              >
                <MenuItem value="main">Mainnet</MenuItem>
                <MenuItem value="test">Testnet</MenuItem>
              </Select>
            </FormControl>

            <StorageSelectUI
              network={networkInput}
              value={storageInput}
              onChange={newVal => setStorageInput(newVal)}
              storageError={storageError}
              setStorageError={setStorageError}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={handleCloseDialog}>Cancel</Button>
            <Button variant="contained" onClick={handleSaveConfig}>
              Save
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  )
}

/**
 * A subcomponent that uses "knownHosts" and merges custom stored hosts for the chosen network
 * to let the user pick from a dropdown or type in a custom host name & URL.
 */
function StorageSelectUI(
  props: Readonly<{
    network: 'main' | 'test'
    value: string
    onChange: (url: string) => void
    storageError: string
    setStorageError: (err: string) => void
  }>
) {
  const { network, value, onChange, storageError, setStorageError } = props
  const [isCustom, setIsCustom] = useState(false)

  useEffect(() => {
    // If value is one of knownHosts, not custom
    setIsCustom(!knownHosts.some(host => host.network === network && host.url === value))
  }, [network, value])
  const hostOptions = knownHosts.filter(host => host.network === network)

  function handleSelect(e: any) {
    const v = e.target.value
    if (v === 'custom') {
      setIsCustom(true)
      onChange('')
      setStorageError('')
    } else {
      setIsCustom(false)
      onChange(v)
      setStorageError('')
    }
  }

  return (
    <Box>
      <FormControl fullWidth error={!!storageError}>
        <InputLabel>Storage Server</InputLabel>
        <Select value={isCustom ? 'custom' : value} label="Storage Server" onChange={handleSelect}>
          {hostOptions.map(opt => (
            <MenuItem key={opt.url} value={opt.url}>
              {opt.name} — {opt.url}
            </MenuItem>
          ))}
          <MenuItem value="custom">Custom</MenuItem>
        </Select>
        {storageError && <FormHelperText>{storageError}</FormHelperText>}
      </FormControl>
      {isCustom && (
        <TextField
          label="Custom Storage URL"
          fullWidth
          sx={{ mt: 2 }}
          value={value}
          onChange={e => onChange(e.target.value)}
          error={!!storageError}
        />
      )}
    </Box>
  )
}

export default HomePage
