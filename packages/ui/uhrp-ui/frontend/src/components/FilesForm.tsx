import React, { useState, useEffect } from 'react'
import {
  Button,
  Grid,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
  Card,
  CardContent,
  Box,
  Divider,
  IconButton,
  Chip,
  Stack,
  Alert,
  Fade
} from '@mui/material'
import {
  Refresh as RefreshIcon,
  Search as SearchIcon,
  Schedule as ScheduleIcon,
  CloudUpload as CloudUploadIcon,
  CloudDownload as CloudDownloadIcon,
  Info as InfoIcon,
  Storage as StorageIcon,
  ContentCopy as ContentCopyIcon
} from '@mui/icons-material'
import { toast } from 'react-toastify'
import constants from '../utils/constants.js'
import WalletClient from '@bsv/sdk/wallet/WalletClient'
import { StorageUploader } from '@bsv/sdk/storage/StorageUploader'
import { StorageDownloader } from '@bsv/sdk/storage/StorageDownloader'

// Define interfaces based on the types provided in your description
interface FindFileData {
  name: string
  size: string
  mimeType: string
  expiryTime: number
}

interface RenewFileResult {
  status: string
  prevExpiryTime?: number
  newExpiryTime?: number
  amount?: number
}

interface FilesFormProps { }

// Helper function to format date from timestamp (Unix epoch in seconds)
const formatDate = (timestamp: number): string => {
  // Convert Unix timestamp (seconds) to milliseconds for the Date constructor
  const date = new Date(timestamp * 1000)
  return date.toLocaleString()
}

// Helper function to format size from bytes
const formatSize = (size: string): string => {
  const sizeNum = parseInt(size, 10)
  if (isNaN(sizeNum)) return size

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let formattedSize = sizeNum

  while (formattedSize >= 1024 && unitIndex < units.length - 1) {
    formattedSize /= 1024
    unitIndex++
  }

  return `${formattedSize.toFixed(2)} ${units[unitIndex]}`
}

// Helper function to shorten file name for display
const getShortFileName = (uhrpUrl: string): string => {
  // Extract just the file name portion if possible
  const parts = uhrpUrl.split('/')
  if (parts.length > 0) {
    const fileName = parts[parts.length - 1]
    // If the file name itself is very long, truncate it
    if (fileName.length > 30) {
      return fileName.substring(0, 15) + '...' + fileName.substring(fileName.length - 10)
    }
    return fileName
  }
  // Fallback to the full URL with protocol removed
  return uhrpUrl.replace(/^(uhrp|https?):(\/\/)?/, '')
}

const FilesForm: React.FC<FilesFormProps> = () => {
  const [storageURL, setStorageURL] = useState<string>('')
  const [storageURLs, setStorageURLs] = useState<string[]>(constants.storageURLs.map(x => x.toString()))
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [openRenewDialog, setOpenRenewDialog] = useState<boolean>(false)
  const [openFindDialog, setOpenFindDialog] = useState<boolean>(false)
  const [openNewOptionDialog, setOpenNewOptionDialog] = useState<boolean>(false)
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [additionalMinutes, setAdditionalMinutes] = useState<number>(180) // Default: 3 Hours
  const [renewalResult, setRenewalResult] = useState<RenewFileResult | null>(null)
  const [findFileUrl, setFindFileUrl] = useState<string>('')
  const [fileDetails, setFileDetails] = useState<FindFileData | null>(null)
  const [newOption, setNewOption] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [downloadingFiles, setDownloadingFiles] = useState<Record<string, boolean>>({}) // Track loading state per file

  useEffect(() => {
    if (constants.storageURLs && constants.storageURLs.length > 0) {
      setStorageURL(constants.storageURLs[0].toString())
    }
  }, [])

  const loadFiles = async () => {
    setLoading(true)
    setError('')
    try {
      const wallet = new WalletClient('auto', 'localhost')
      // @ts-ignore - Using the new methods that exist at runtime but not in TypeScript definitions
      const storageUploader = new StorageUploader({
        storageURL,
        wallet
      })

      // @ts-ignore - Using the new StorageUploader.listUploads() method
      const filesList = await storageUploader.listUploads()
      console.log('list', filesList)
      setFiles(filesList || [])
    } catch (err) {
      console.error('Error loading files:', err)
      setError('Failed to load files. Please ensure your wallet is connected.')
      toast.error('Failed to load files')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectChange = (event: React.ChangeEvent<{ value: unknown }>) => {
    const selectedValue = event.target.value as string
    if (selectedValue === 'add-new-option') {
      setOpenNewOptionDialog(true)
    } else {
      setStorageURL(selectedValue)
    }
  }

  const handleCloseNewOptionDialog = () => {
    setOpenNewOptionDialog(false)
  }

  const handleAddOption = () => {
    if (newOption.trim() !== '' && !storageURLs.includes(newOption)) {
      setStorageURLs([...storageURLs, newOption])
      setStorageURL(newOption)
      setNewOption('')
    }
    setOpenNewOptionDialog(false)
  }

  const handleRenewClick = (uhrpUrl: string) => {
    setSelectedFile(uhrpUrl)
    setRenewalResult(null)
    setOpenRenewDialog(true)
  }

  const handleFindClick = () => {
    setFileDetails(null)
    setOpenFindDialog(true)
  }

  const handleCloseRenewDialog = () => {
    setOpenRenewDialog(false)
  }

  const handleCloseFindDialog = () => {
    setOpenFindDialog(false)
  }

  const handleRenewFile = async () => {
    setLoading(true)
    try {
      const wallet = new WalletClient('auto', 'localhost')
      // @ts-ignore - Using the new methods that exist at runtime but not in TypeScript definitions
      const storageUploader = new StorageUploader({
        storageURL,
        wallet
      })
      console.log('t', selectedFile)
      console.log(additionalMinutes)
      // @ts-ignore - Using the new StorageUploader.renewFile() method
      const result = await storageUploader.renewFile(selectedFile, additionalMinutes)
      setRenewalResult(result)

      if (result.status === 'success') {
        toast.success('File renewed successfully')
        // Refresh file list after successful renewal
        loadFiles()
      } else {
        toast.error('File renewal failed')
      }
    } catch (err) {
      console.error('Error renewing file:', err)
      toast.error('Error renewing file')
    } finally {
      setLoading(false)
    }
  }

  const handleFindFile = async () => {
    if (!findFileUrl || !findFileUrl.trim()) {
      toast.error('Please enter a valid UHRP URL')
      return
    }

    setLoading(true)
    setFileDetails(null)
    try {
      const wallet = new WalletClient('auto', 'localhost')
      // @ts-ignore - Using the new methods that exist at runtime but not in TypeScript definitions
      const storageUploader = new StorageUploader({
        storageURL,
        wallet
      })

      // @ts-ignore - Using the new StorageUploader.findFile() method
      const result = await storageUploader.findFile(findFileUrl)
      setFileDetails(result)
    } catch (err) {
      console.error('Error finding file:', err)
      toast.error('Error finding file')
    } finally {
      setLoading(false)
    }
  }

  const handleDownloadFile = async (uhrpUrl: string) => {
    // Set loading state for this specific file only
    setDownloadingFiles(prev => ({ ...prev, [uhrpUrl]: true }))

    try {
      // Create the StorageDownloader with mainnet as default
      const storageDownloader = new StorageDownloader({ networkPreset: 'mainnet' })

      // Attempt to download the file
      const { mimeType, data } = await storageDownloader.download(uhrpUrl.trim())

      if (!data || !mimeType) {
        throw new Error(`Error fetching file from ${uhrpUrl}`)
      }

      // Convert number[] to a Uint8Array, then make a Blob
      const dataArray = new Uint8Array(data)
      const blob = new Blob([dataArray], { type: mimeType })
      const url = URL.createObjectURL(blob)

      // Programmatically trigger file download
      const link = document.createElement('a')
      link.href = url
      link.download = uhrpUrl.trim().split('/').pop() || 'download'
      document.body.appendChild(link)
      link.click()

      // Cleanup
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      toast.success('File downloaded successfully')
    } catch (error) {
      console.error(error)
      toast.error('An error occurred during download')
    } finally {
      // Clear loading state for this specific file only
      setDownloadingFiles(prev => {
        const updated = { ...prev }
        delete updated[uhrpUrl]
        return updated
      })
    }
  }

  return (
    <Box sx={{ py: 2 }} className="files-form-container">
      <Card elevation={3} sx={{ mb: 3, overflow: 'visible', borderRadius: 2 }}>
        <CardContent sx={{ p: 3 }}>
          <Box display="flex" alignItems="center" mb={3}>
            <StorageIcon fontSize="large" color="primary" sx={{ mr: 2 }} />
            <Typography variant="h5" component="h2">Manage Your Files</Typography>
          </Box>

          <Box sx={{ mb: 3 }}>
            <FormControl fullWidth variant="outlined">
              <InputLabel>UHRP Storage Server URL</InputLabel>
              <Select
                value={storageURL}
                onChange={handleSelectChange}
                label="Storage Server URL"
                sx={{ borderRadius: 1 }}
              >
                {storageURLs.map((url, index) => (
                  <MenuItem key={index} value={url.toString()}>
                    {url.toString()}
                  </MenuItem>
                ))}
                <MenuItem value="add-new-option">
                  <Box display="flex" alignItems="center">
                    <CloudUploadIcon fontSize="small" sx={{ mr: 1 }} />
                    Add New Server
                  </Box>
                </MenuItem>
              </Select>
            </FormControl>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
            <Button
              variant="contained"
              color="primary"
              onClick={loadFiles}
              disabled={loading}
              startIcon={<RefreshIcon />}
              sx={{ borderRadius: 2, px: 3 }}
            >
              {loading ? <CircularProgress size={20} color="inherit" /> : 'Load My Files'}
            </Button>
            <Button
              variant="outlined"
              color="primary"
              onClick={handleFindClick}
              disabled={loading}
              startIcon={<SearchIcon />}
              sx={{ borderRadius: 2, px: 3 }}
            >
              Find File Info
            </Button>
          </Stack>

          {error && (
            <Fade in={!!error}>
              <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
            </Fade>
          )}
        </CardContent>
      </Card>

      {files.length > 0 ? (
        <Card elevation={2} sx={{ width: '100%' }}>
          <Box sx={{ p: 2, bgcolor: 'background.paper', borderRadius: '4px 4px 0 0' }}>
            <Typography variant="h6" component="h3">
              Your Files <Chip label={files.length} size="small" color="primary" sx={{ ml: 1 }} />
            </Typography>
          </Box>
          <Divider />
          <TableContainer component={Paper} sx={{ boxShadow: 'none', borderRadius: 0, width: '100%' }}>
            <Table sx={{ width: '100%' }}>
              <TableHead sx={{ bgcolor: 'rgba(0, 0, 0, 0.02)' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 'bold', width: '55%' }}>File Name</TableCell>
                  <TableCell sx={{ fontWeight: 'bold', width: '20%' }}>Expiry Time</TableCell>
                  <TableCell sx={{ fontWeight: 'bold', width: '25%' }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {files.map((file, index) => (
                  <TableRow key={index} hover sx={{
                    '&:last-child td, &:last-child th': { border: 0 },
                    transition: 'background-color 0.2s'
                  }}>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Tooltip title={file.uhrpUrl} arrow placement="top">
                          <Typography
                            noWrap
                            sx={{
                              maxWidth: '85%',
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              flex: 1
                            }}
                          >
                            {getShortFileName(file.uhrpUrl)}
                          </Typography>
                        </Tooltip>
                        <Tooltip title="Copy URL to clipboard" arrow>
                          <IconButton
                            size="small"
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(file.uhrpUrl)
                                .then(() => {
                                  setCopiedUrl(file.uhrpUrl);
                                  toast.success('URL copied to clipboard');
                                  setTimeout(() => setCopiedUrl(null), 2000);
                                })
                                .catch(err => {
                                  console.error('Could not copy text: ', err);
                                  toast.error('Failed to copy URL');
                                });
                            }}
                            color={copiedUrl === file.uhrpUrl ? "success" : "default"}
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Box display="flex" alignItems="center">
                        <ScheduleIcon fontSize="small" color="action" sx={{ mr: 1, opacity: 0.7 }} />
                        {formatDate(file.expiryTime)}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-start' }}>
                        <Button
                          size="small"
                          variant="contained"
                          color="primary"
                          startIcon={downloadingFiles[file.uhrpUrl] ? <CircularProgress size={16} color="inherit" /> : <CloudDownloadIcon />}
                          onClick={() => handleDownloadFile(file.uhrpUrl)}
                          disabled={!!downloadingFiles[file.uhrpUrl]}
                          sx={{ borderRadius: 2 }}
                        >
                          Download
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="primary"
                          startIcon={<ScheduleIcon />}
                          onClick={() => handleRenewClick(file.uhrpUrl)}
                          sx={{ borderRadius: 2 }}
                        >
                          Renew
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : (
        <Card elevation={2} sx={{ p: 5, textAlign: 'center', width: '100%' }}>
          {loading ? (
            <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center">
              <CircularProgress size={40} sx={{ mb: 2 }} />
              <Typography variant="body1">Loading files...</Typography>
            </Box>
          ) : (
            <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center">
              <StorageIcon sx={{ fontSize: 60, color: 'text.secondary', opacity: 0.5, mb: 2 }} />
              <Typography variant="body1" color="text.secondary">
                No files found. Click "Load My Files" to view your uploaded files.
              </Typography>
            </Box>
          )}
        </Card>
      )}

      {/* Renewal Dialog */}
      <Dialog
        open={openRenewDialog}
        onClose={handleCloseRenewDialog}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          elevation: 24,
          sx: { borderRadius: 2 }
        }}
      >
        <DialogTitle sx={{ bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center' }}>
          <ScheduleIcon sx={{ mr: 1 }} /> Renew File Hosting
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              UHRP URL
            </Typography>
            <Typography variant="body1" sx={{ wordBreak: 'break-all', bgcolor: 'action.hover', p: 1, borderRadius: 1 }}>
              {selectedFile}
            </Typography>
          </Box>

          <FormControl fullWidth variant="outlined" sx={{ mb: 3 }}>
            <InputLabel>Additional Duration</InputLabel>
            <Select
              fullWidth
              label="Additional Duration"
              variant="outlined"
              value={additionalMinutes}
              onChange={(e: React.ChangeEvent<{ value: unknown }>) => setAdditionalMinutes(Number(e.target.value))}
            >
              <MenuItem value={180}>3 Hours</MenuItem>
              <MenuItem value={1440}>1 Day</MenuItem>
              <MenuItem value={1440 * 7}>1 Week</MenuItem>
              <MenuItem value={1440 * 30}>1 Month</MenuItem>
              <MenuItem value={1440 * 90}>3 Months</MenuItem>
              <MenuItem value={1440 * 180}>6 Months</MenuItem>
              <MenuItem value={525600}>1 Year</MenuItem>
              <MenuItem value={525600 * 2}>2 Years</MenuItem>
              <MenuItem value={525600 * 5}>5 Years</MenuItem>
            </Select>
          </FormControl>

          {renewalResult && (
            <Box sx={{ p: 2, bgcolor: renewalResult.status === 'success' ? 'success.light' : 'info.light', borderRadius: 2, mt: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
                Renewal {renewalResult.status === 'success' ? 'Successful' : 'Result'}
              </Typography>

              <Stack spacing={1}>
                <Box display="flex">
                  <Typography variant="body2" sx={{ fontWeight: 'medium', width: 140 }}>Status:</Typography>
                  <Chip
                    size="small"
                    label={renewalResult.status}
                    color={renewalResult.status === 'success' ? 'success' : 'default'}
                  />
                </Box>

                {renewalResult.prevExpiryTime && (
                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 140 }}>Previous Expiry:</Typography>
                    <Typography variant="body2">{formatDate(renewalResult.prevExpiryTime)}</Typography>
                  </Box>
                )}

                {renewalResult.newExpiryTime && (
                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 140 }}>New Expiry:</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{formatDate(renewalResult.newExpiryTime)}</Typography>
                  </Box>
                )}

                {renewalResult.amount && (
                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 140 }}>Amount:</Typography>
                    <Typography variant="body2">{renewalResult.amount}</Typography>
                  </Box>
                )}
              </Stack>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            onClick={handleCloseRenewDialog}
            variant="outlined"
            sx={{ borderRadius: 2 }}
          >
            Close
          </Button>
          <Button
            onClick={handleRenewFile}
            variant="contained"
            color="primary"
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <ScheduleIcon />}
            sx={{ borderRadius: 2 }}
          >
            Renew File
          </Button>
        </DialogActions>
      </Dialog>

      {/* Find File Dialog */}
      <Dialog
        open={openFindDialog}
        onClose={handleCloseFindDialog}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          elevation: 24,
          sx: { borderRadius: 2 }
        }}
      >
        <DialogTitle sx={{ bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center' }}>
          <SearchIcon sx={{ mr: 1 }} /> Find File Information
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <Box sx={{ mb: 3 }}>
            <TextField
              fullWidth
              label="UHRP URL"
              variant="outlined"
              value={findFileUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFindFileUrl(e.target.value)}
              placeholder="Enter UHRP URL to find file information"
              sx={{ mb: 2 }}
              InputProps={{
                endAdornment: (
                  <IconButton
                    size="small"
                    onClick={handleFindFile}
                    disabled={loading || !findFileUrl.trim()}
                    color="primary"
                  >
                    <SearchIcon />
                  </IconButton>
                )
              }}
            />
            <Typography variant="caption" color="text.secondary">
              Enter the complete UHRP URL of the file you want to find information about
            </Typography>
          </Box>

          {fileDetails && (
            <Fade in={!!fileDetails}>
              <Box sx={{ p: 2, bgcolor: 'info.light', borderRadius: 2, mt: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2, display: 'flex', alignItems: 'center' }}>
                  <InfoIcon sx={{ mr: 1, fontSize: '1rem' }} /> File Details
                </Typography>

                <Stack spacing={1.5}>
                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 120 }}>Name:</Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{fileDetails.name}</Typography>
                  </Box>

                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 120 }}>Size:</Typography>
                    <Chip
                      size="small"
                      label={formatSize(fileDetails.size)}
                      variant="outlined"
                      sx={{ borderRadius: 1 }}
                    />
                  </Box>

                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 120 }}>Type:</Typography>
                    <Typography variant="body2">{fileDetails.mimeType}</Typography>
                  </Box>

                  <Box display="flex">
                    <Typography variant="body2" sx={{ fontWeight: 'medium', width: 120 }}>Expiry:</Typography>
                    <Box display="flex" alignItems="center">
                      <ScheduleIcon fontSize="small" color="action" sx={{ mr: 1, fontSize: '1rem' }} />
                      <Typography variant="body2">{formatDate(fileDetails.expiryTime)}</Typography>
                    </Box>
                  </Box>
                </Stack>
              </Box>
            </Fade>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            onClick={handleCloseFindDialog}
            variant="outlined"
            sx={{ borderRadius: 2 }}
          >
            Close
          </Button>
          <Button
            onClick={handleFindFile}
            variant="contained"
            color="primary"
            disabled={loading || !findFileUrl.trim()}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <SearchIcon />}
            sx={{ borderRadius: 2 }}
          >
            Find File
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add New Server URL Dialog */}
      <Dialog
        open={openNewOptionDialog}
        onClose={handleCloseNewOptionDialog}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          elevation: 24,
          sx: { borderRadius: 2 }
        }}
      >
        <DialogTitle sx={{ bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center' }}>
          <CloudUploadIcon sx={{ mr: 1 }} /> Add New Server URL
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <TextField
            autoFocus
            margin="dense"
            label="Storage Server URL"
            type="text"
            fullWidth
            value={newOption}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOption(e.target.value)}
            placeholder="Enter complete URL including http:// or https://"
            sx={{ mb: 1 }}
          />
          <Typography variant="caption" color="text.secondary">
            Enter the full URL of the UHRP storage server you want to add
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            onClick={handleCloseNewOptionDialog}
            variant="outlined"
            sx={{ borderRadius: 2 }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAddOption}
            variant="contained"
            color="primary"
            disabled={!newOption.trim()}
            startIcon={<CloudUploadIcon />}
            sx={{ borderRadius: 2 }}
          >
            Add Server
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default FilesForm
