// frontend/src/index.tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import { CssBaseline } from '@mui/material'
import { ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

import App from './App'
import web3Theme from './theme'
const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('#root not found in DOM')
}

const root = createRoot(rootEl)

const renderApp = (Component: React.ComponentType) => {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <ThemeProvider theme={web3Theme}>
          <CssBaseline />
          <ToastContainer
            position="top-right"
            autoClose={5000}
            hideProgressBar={false}
            newestOnTop={false}
            closeOnClick
            rtl={false}
            pauseOnFocusLoss
            draggable
            pauseOnHover
          />
          <Component />
        </ThemeProvider>
      </BrowserRouter>
    </React.StrictMode>
  )
}

renderApp(App)

// Vite HMR (safe no-op if not running under Vite)
if (import.meta.hot) {
  import.meta.hot.accept()
}
