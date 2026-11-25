import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import {
    createTheme,
    ThemeProvider,
    CssBaseline,
    CircularProgress,
    Box
} from '@mui/material';

import HomePage from './pages/HomePage';
import ActionsPage from './pages/ActionsPage';
import OutputsPage from './pages/OutputsPage';
import KeysLinkagePage from './pages/KeysLinkagePage';
import CryptoPage from './pages/CryptoPage';
import IdentityResolutionPage from './pages/IdentityResolutionPage';
import CertificatesPage from './pages/CertificatesPage';
import ImportExportPage from './pages/ImportExportPage';
import UtilitiesPage from './pages/UtilitiesPage';
import DataPage from './pages/DataPage';

import MainLayout from './components/MainLayout';
import { WalletProvider, useWallet } from './contexts/WalletContext';

const theme = createTheme({
    palette: {
        mode: 'light'
    }
});

function AppContent() {
    // We can check the wallet context to see if it's "still loading"
    // so that we only show a spinner until it finishes.
    const { loadingInitialWallet } = useWallet();

    // If still loading, show a splash or spinner
    if (loadingInitialWallet) {
        return (
            <Box
                minHeight="100vh"
                display="flex"
                justifyContent="center"
                alignItems="center"
            >
                <CircularProgress />
            </Box>
        );
    }

    // Now if the wallet is loaded, we can show the normal routes.
    return (
        <Routes>
            <Route path="/" element={<HomePage />} />

            {/**
       * The protected pages that require an active wallet config.
       * BUT in this approach, we let the user *see* them with or without a wallet;
       * if you want to truly protect them, you can do:
       *   {wallet ? <ActionsPage/> : <Navigate to="/" />}
       */}
            <Route element={<MainLayout />}>
                <Route path="/actions" element={<ActionsPage />} />
                <Route path="/outputs" element={<OutputsPage />} />
                <Route path="/keys" element={<KeysLinkagePage />} />
                <Route path="/crypto" element={<CryptoPage />} />
                <Route path="/identity-resolution" element={<IdentityResolutionPage />} />
                <Route path="/certificates" element={<CertificatesPage />} />
                <Route path="/import-export" element={<ImportExportPage />} />
                <Route path="/utilities" element={<UtilitiesPage />} />
                <Route path="/data" element={<DataPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
}

function App() {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <WalletProvider>
                <BrowserRouter>
                    <AppContent />
                </BrowserRouter>
            </WalletProvider>
        </ThemeProvider>
    );
}

export default App;
