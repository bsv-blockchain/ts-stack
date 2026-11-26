import React, { useEffect, useState } from 'react'
import { Container, Typography, Tabs, Tab, Grid } from '@mui/material'
import DownloadForm from './components/DownloadForm.js'
import UploadForm from './components/UploadForm.js'
import FilesForm from './components/FilesForm.js'
import Footer from './components/Footer.js'
import NoMncModal from './components/NoMncModal/NoMncModal'
import { WalletClient } from '@bsv/sdk'
import './App.scss'

const App: React.FC = () => {
  const [tabIndex, setTabIndex] = useState<number>(0)
  const [walletMissing, setWalletMissing] = useState(false)

  useEffect(() => {
    let stopped = false
    let checking = false

    const checkWallet = async () => {
      try {
        const wallet = new WalletClient('auto')
        try {
          await wallet.getNetwork()
        } catch {
          if (!stopped) setWalletMissing(true)
          return
        }
        if (stopped) return

        await wallet.waitForAuthentication()
        if (!stopped) {
          clearInterval(intervalId)
          setWalletMissing(false)
        }
      } catch {
        // Retry if authentication is declined or the wallet disconnects.
      } finally {
        checking = false
      }
    }
    const intervalId = setInterval(() => {
      if (checking) return
      checking = true
      void checkWallet()
    }, 1000)

    return () => {
      stopped = true
      clearInterval(intervalId)
    }
  }, [])

  const handleTabChange = (event: React.ChangeEvent<{}>, newValue: number) => {
    setTabIndex(newValue)
  }

  return (
    <Container maxWidth="md" sx={{ paddingTop: '2em', paddingBottom: '2em' }}>
      <NoMncModal open={walletMissing} onClose={() => setWalletMissing(false)} />
      <Grid container spacing={2}>
        <Grid size={{ xs: 12 }} sx={{ mb: 2 }}>
          <Typography variant="h4" align="center" sx={{ fontWeight: 'bold', mb: 1 }}>
            UHRP Storage UI
          </Typography>
          <Typography color="textSecondary" component="p" align="center" sx={{ mb: 3 }}>
            Upload and Download Content
          </Typography>
          <Tabs
            value={tabIndex}
            onChange={handleTabChange}
            indicatorColor="primary"
            textColor="primary"
            variant="fullWidth"
            sx={{
              '& .MuiTab-root': {
                borderRadius: '4px 4px 0 0',
                fontWeight: 'medium',
                py: 1.5
              }
            }}
          >
            <Tab label="Download" />
            <Tab label="Upload" />
            <Tab label="Files" />
          </Tabs>
        </Grid>
        <Grid size={{ xs: 12 }}>
          <div style={{ minHeight: '400px' }}>
            {tabIndex === 0 && <DownloadForm />}
            {tabIndex === 1 && <UploadForm />}
            {tabIndex === 2 && <FilesForm />}
          </div>
        </Grid>
        <Grid size={{ xs: 12 }}>
          <Footer />
        </Grid>
      </Grid>
    </Container>
  )
}

export default App
