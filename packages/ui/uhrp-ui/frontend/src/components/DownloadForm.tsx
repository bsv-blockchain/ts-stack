import React, { FormEvent, useState, useEffect } from 'react'
import {
  Button,
  LinearProgress,
  Grid,
  TextField,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material'
import { CloudDownload } from '@mui/icons-material'
import { toast } from 'react-toastify'
import { StorageDownloader } from '@bsv/sdk/storage/StorageDownloader'

interface DownloadFormProps { }

type NetworkType = 'mainnet' | 'testnet' | 'local';

const DownloadForm: React.FC<DownloadFormProps> = () => {
  const [downloadURL, setDownloadURL] = useState<string>('')
  const [network, setNetwork] = useState<NetworkType>('mainnet')
  const [loading, setLoading] = useState<boolean>(false)
  const [inputsValid, setInputsValid] = useState<boolean>(false)

  // Simple form validation: must have a non-empty download URL
  useEffect(() => {
    setInputsValid(downloadURL.trim() !== '')
  }, [downloadURL])

  const handleDownload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)

    try {
      // Create the StorageDownloader with selected network
      const storageDownloader = new StorageDownloader({ networkPreset: network })

      // Attempt to download the file
      const { mimeType, data } = await storageDownloader.download(downloadURL.trim())

      if (!data || !mimeType) {
        throw new Error(`Error fetching file from ${downloadURL}`)
      }

      // Convert number[] to a Uint8Array, then make a Blob
      const dataArray = new Uint8Array(data)
      const blob = new Blob([dataArray], { type: mimeType })
      const url = URL.createObjectURL(blob)

      // Programmatically trigger file download
      const link = document.createElement('a')
      link.href = url
      link.download = downloadURL.trim() || 'download'
      document.body.appendChild(link)
      link.click()

      // Cleanup
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error(error)
      toast.error('An error occurred during download')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleDownload}>
      <Grid container spacing={3} sx={{ py: 2 }}>
        <Grid item xs={12}>
          <Typography variant='h5' gutterBottom sx={{ fontWeight: 'medium' }}>Download Form</Typography>
          <Typography color='textSecondary' paragraph sx={{ mb: 3 }}>
            Download files from UHRP Storage
          </Typography>
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            variant='outlined'
            label='UHRP URL'
            placeholder='Enter UHRP URL to download'
            value={downloadURL}
            onChange={(e) => setDownloadURL(e.target.value)}
            sx={{ mb: 2 }}
          />
        </Grid>

        <Grid item xs={12}>
          <FormControl fullWidth variant='outlined' sx={{ mb: 3 }}>
            <InputLabel id='network-select-label'>Network</InputLabel>
            <Select
              labelId='network-select-label'
              value={network}
              label='Network'
              onChange={(event: React.ChangeEvent<{ value: unknown }>) => {
                const value = event.target.value as string;
                setNetwork(value as NetworkType);
              }}
            >
              <MenuItem value='mainnet'>Mainnet</MenuItem>
              <MenuItem value='testnet'>Testnet</MenuItem>
              <MenuItem value='local'>Local</MenuItem>
            </Select>
          </FormControl>
        </Grid>

        <Grid item xs={12} sx={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            variant='contained'
            color='primary'
            size='large'
            type='submit'
            disabled={loading || !inputsValid}
            startIcon={<CloudDownload />}
            sx={{ borderRadius: 2, px: 3, py: 1 }}
          >
            Download
          </Button>
        </Grid>

        {loading && (
          <Grid item xs={12} sx={{ mt: 2 }}>
            <LinearProgress sx={{ height: 6, borderRadius: 3 }} />
          </Grid>
        )}
      </Grid>
    </form>
  )
}

export default DownloadForm
