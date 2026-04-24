// frontend/src/pages/Mint/index.tsx
import React, { useState, useRef } from 'react'
import { Container, Typography, Grid, Button, TextField, Paper, IconButton, CircularProgress, Backdrop, Box } from '@mui/material'
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew'
import AddAPhotoIcon from '@mui/icons-material/AddAPhoto'
import { Link } from 'react-router-dom'
import { toast } from 'react-toastify'
import useStyles from './mint-style'
import { StorageUploader } from '@bsv/sdk'

import { btms, walletClient } from '../../btms'
import { formatBtmsError } from '../../utils/formatBtmsError'

interface MintProps {
  history: {
    push: (path: string) => void
  }
}

const Mint: React.FC<MintProps> = ({ history }) => {
  const classes = useStyles()
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [description, setDescription] = useState('')
  const [photoURL, setPhotoURL] = useState<string | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handlePhotoClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0]
      setPhotoFile(file)
      const urlReader = new FileReader()
      urlReader.onload = () => {
        setPhotoURL(urlReader.result as string)
      }
      urlReader.readAsDataURL(file)
    }
  }

  const mint = async () => {
    setLoading(true)
    try {
      if (name.trim() === '') {
        toast.error('Enter a name for the token!')
        return
      }
      if (quantity.trim() === '' || Number.isNaN(Number(quantity))) {
        toast.error('Enter a quantity for the max number of tokens!')
        return
      }
      if (description.trim() === '') {
        toast.error('Enter a description for the token!')
        return
      }

      // Upload image to UHRP if provided
      let iconURL: string | null = null
      if (photoFile) {
        try {
          // Read file as array buffer
          const arrayBuffer = await photoFile.arrayBuffer()
          const fileData = new Uint8Array(arrayBuffer)

          // Upload to UHRP using StorageUploader
          const uploader = new StorageUploader({
            storageURL: 'https://nanostore.babbage.systems',
            wallet: walletClient
          })

          const uploadResult = await uploader.publishFile({
            file: {
              data: fileData,
              type: photoFile.type
            },
            retentionPeriod: 525600 // 1 year in minutes
          })

          iconURL = uploadResult.uhrpURL

          toast.success('Image uploaded successfully!')
        } catch (uploadErr: any) {
          toast.error('Failed to upload image. Continuing without image.')
          // Continue without image rather than failing the entire mint
        }
      }

      const amount = Number(quantity)
      const res = await btms.issue(amount, {
        name,
        description,
        iconURL
      })

      toast.success(`Issued ${quantity} ${name} successfully!`)
      history.push('/')
    } catch (err: unknown) {
      toast.error(formatBtmsError(err, 'Something went wrong while minting.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Full-screen loading overlay */}
      <Backdrop
        sx={{
          color: '#fff',
          zIndex: (theme) => theme.zIndex.drawer + 1,
          flexDirection: 'column',
          gap: 2
        }}
        open={loading}
      >
        <CircularProgress color="inherit" size={48} />
        <Typography variant="h6">Issuing asset on blockchain...</Typography>
        <Typography variant="body2">This may take a moment</Typography>
      </Backdrop>

      <Container maxWidth="lg" sx={{ pb: 8 }}>
        <Grid container alignItems="center" className={classes.button}>
          <Button component={Link} to="/" color="secondary">
            <ArrowBackIosNewIcon className={classes.back_icon} /> My Assets
          </Button>
        </Grid>

        <Paper elevation={0} sx={{ p: { xs: 3, md: 4 }, mt: 1.5 }}>
          <Grid container spacing={4}>
            <Grid item xs={12} md={7}>
              <Typography variant="h4" sx={{ fontWeight: 700 }} className={classes.title}>
                Issue New Asset
              </Typography>
              <Typography variant="body1" color="text.secondary">
                Create a new tokenized asset with a clear name, description, and initial supply.
              </Typography>

              <Grid item container direction="column" className={classes.sub_title}>
                {/* Token name */}
                <Grid item container direction="column" className={classes.form}>
                  <Grid item>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Asset Name
                    </Typography>
                  </Grid>
                  <Grid item>
                    <TextField
                      placeholder="e.g. Gold, USD, Real Estate Fund"
                      variant="outlined"
                      color="secondary"
                      multiline
                      fullWidth
                      helperText="Required"
                      onChange={e => setName(e.target.value)}
                    />
                  </Grid>
                </Grid>

                {/* Image */}
                <Grid item container direction="column" className={classes.form}>
                  <Grid item>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Image
                    </Typography>
                  </Grid>
                  <Grid item container>
                    <Paper elevation={0} className={classes.photo_container}>
                      {photoURL ? (
                        <Grid item className={classes.photo_preview}>
                          <img src={photoURL} className={classes.photo_preview_img} alt="preview" />
                        </Grid>
                      ) : (
                        <Grid item>
                          <IconButton color="secondary" onClick={handlePhotoClick}>
                            <AddAPhotoIcon />
                            <input
                              type="file"
                              accept=".png, .svg, .jpeg, .jpg"
                              style={{ display: 'none' }}
                              ref={fileInputRef}
                              onChange={handleFileChange}
                            />
                          </IconButton>
                        </Grid>
                      )}
                    </Paper>
                  </Grid>
                </Grid>

                {/* Quantity */}
                <Grid item container direction="column" className={classes.form}>
                  <Grid item>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Quantity
                    </Typography>
                  </Grid>
                  <Grid item>
                    <Typography variant="body2">Total units to issue (e.g. ounces, dollars, shares)</Typography>
                  </Grid>
                  <Grid item>
                    <TextField
                      placeholder="Quantity"
                      value={quantity}
                      variant="outlined"
                      color="secondary"
                      fullWidth
                      helperText="Required"
                      onChange={e => setQuantity(e.target.value.replace(/\D/g, ''))}
                    />
                  </Grid>
                </Grid>

                {/* Description */}
                <Grid item container direction="column" className={classes.form}>
                  <Grid item>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Asset Description
                    </Typography>
                  </Grid>
                  <Grid item>
                    <TextField
                      placeholder="Describe what this asset represents"
                      multiline
                      minRows={3}
                      variant="outlined"
                      color="secondary"
                      fullWidth
                      helperText="Required"
                      onChange={e => setDescription(e.target.value)}
                    />
                  </Grid>
                </Grid>
              </Grid>
            </Grid>

            <Grid item xs={12} md={5}>
              <Box sx={{ position: 'sticky', top: 24, display: 'grid', gap: 2 }}>
                <Typography variant="overline" color="text.secondary">
                  Preview
                </Typography>
                <Paper elevation={0} sx={{ p: 3, background: 'rgba(255, 255, 255, 0.7)' }}>
                  <Grid container direction="column" rowGap={1.5}>
                    <Typography variant="subtitle2">Asset</Typography>
                    <Typography sx={{ wordBreak: 'break-word' }}>{name || 'Untitled Asset'}</Typography>
                    <Typography variant="subtitle2">Description</Typography>
                    <Typography sx={{ wordBreak: 'break-word' }}>{description || 'No description yet.'}</Typography>
                    <Typography variant="subtitle2">Quantity</Typography>
                    <Typography>{quantity || '0'}</Typography>
                  </Grid>
                </Paper>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={mint}
                  disabled={loading}
                  startIcon={loading ? <CircularProgress size={16} color="inherit" /> : null}
                >
                  {loading ? 'Issuing...' : 'Issue Asset'}
                </Button>
              </Box>
            </Grid>
          </Grid>
        </Paper>
      </Container>
    </div>
  )
}

export default Mint
