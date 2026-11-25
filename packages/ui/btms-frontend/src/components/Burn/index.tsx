// React / UI (btms-ui)
import React, { useState } from 'react'
import {
  Typography,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  CircularProgress,
  Box,
  Alert
} from '@mui/material'
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment'
import { toast } from 'react-toastify'

import { btms } from '../../btms'
import { AssetView } from '../../btms/types'
import { formatBtmsError } from '../../utils/formatBtmsError'

interface BurnProps {
  assetId: string
  asset: AssetView
  onReloadNeeded?: () => void
}

const Burn: React.FC<BurnProps> = ({ assetId, asset, onReloadNeeded = () => { } }) => {
  const [quantity, setQuantity] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const qty = Number(quantity)
  const quantityValid = quantity.trim() !== '' && Number.isFinite(qty) && qty > 0 && qty <= asset.balance

  const canBurn = asset.balance > 0 && quantityValid && !loading

  const handleBurnCancel = () => {
    setQuantity('')
    setOpen(false)
  }

  const handleBurn = async () => {
    try {
      setLoading(true)

      if (!quantityValid) {
        toast.error('Invalid amount!')
        return
      }

      const amountToBurn = qty === asset.balance ? undefined : qty
      const result = await btms.burn(assetId, amountToBurn)

      if (!result.success) {
        throw new Error(result.error || 'Failed to burn tokens')
      }

      try {
        onReloadNeeded()
      } catch { }

      toast.success(`Burned ${qty} ${asset.name} successfully!`)
      setOpen(false)
      setQuantity('')
    } catch (err: unknown) {
      toast.error(formatBtmsError(err), { autoClose: 5000 })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="outlined"
        color="error"
        disabled={asset.balance === 0}
        sx={{ minWidth: 100 }}
        startIcon={<LocalFireDepartmentIcon />}
      >
        Burn
      </Button>

      <Dialog open={open} onClose={loading ? undefined : handleBurnCancel} maxWidth="sm" fullWidth>
        <DialogTitle variant="h4" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
          <LocalFireDepartmentIcon color="error" />
          Burn {asset.name}
        </DialogTitle>

        <DialogContent sx={{ minHeight: 200 }}>
          {loading && (
            <Box sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              py: 4,
              gap: 2
            }}>
              <CircularProgress color="error" size={48} />
              <Typography variant="body1">Processing burn...</Typography>
              <Typography variant="body2" color="text.secondary">Removing tokens from circulation</Typography>
            </Box>
          )}

          {!loading && (
            <>
              <Alert severity="warning" sx={{ mb: 3 }}>
                <Typography variant="body2">
                  <strong>Warning:</strong> Burning tokens permanently removes them from circulation. This action cannot be undone.
                </Typography>
              </Alert>

              <Typography variant="h6" sx={{ mb: 1 }}>
                Amount to Burn:
              </Typography>

              <TextField
                value={quantity}
                variant="outlined"
                color="error"
                fullWidth
                placeholder="Enter amount"
                helperText={asset.balance > 0 ? `Available: ${asset.balance}` : 'No balance available'}
                onChange={e => setQuantity(e.target.value.replace(/\D/g, ''))}
                sx={{ mb: 2 }}
              />

              <Button
                variant="text"
                color="error"
                size="small"
                onClick={() => setQuantity(String(asset.balance))}
              >
                Burn All ({asset.balance})
              </Button>
            </>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button disabled={loading} color="inherit" variant="outlined" onClick={handleBurnCancel}>
            Cancel
          </Button>

          <Button
            disabled={!canBurn}
            color="error"
            variant="contained"
            onClick={handleBurn}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <LocalFireDepartmentIcon />}
          >
            {loading ? 'Burning...' : 'Burn'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default Burn
