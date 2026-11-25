import { useState } from 'react';
import {
    Box,
    Typography,
    Paper,
    Stack,
    TextField,
    Button
} from '@mui/material';
import { useWallet } from '../contexts/WalletContext';
import { getActiveConfigId, getConfigById } from '../utils/configStorage';

function UtilitiesPage() {
    const { wallet } = useWallet();

    const [authStatus, setAuthStatus] = useState('');
    const [heightResult, setHeightResult] = useState('');
    const [headerHeight, setHeaderHeight] = useState('');
    const [headerResult, setHeaderResult] = useState('');
    const [networkResult, setNetworkResult] = useState('');
    const [versionResult, setVersionResult] = useState('');
    const [basketName, setBasketName] = useState<string>('default');
    const [basketResult, setBasketResult] = useState('');
    const [privateKey, setPrivateKey] = useState<string>('');
    const handleCheckAuth = async () => {
        if (!wallet) return;
        try {
            const resp = await wallet.isAuthenticated({});
            setAuthStatus(resp.authenticated ? 'Authenticated' : 'Not Authenticated');
        } catch (err) {
            console.error(err);
        }
    };

    const handleWaitAuth = async () => {
        if (!wallet) return;
        try {
            const resp = await wallet.waitForAuthentication({});
            setAuthStatus(resp.authenticated ? 'Authenticated' : 'Not Authenticated');
        } catch (err) {
            console.error(err);
        }
    };

    const handleGetHeight = async () => {
        if (!wallet) return;
        try {
            const resp = await wallet.getHeight({});
            setHeightResult(String(resp.height));
        } catch (err) {
            console.error(err);
        }
    };

    const handleComputeValueForBasket = async () => {
        if (!wallet || !basketName) return;
        try {
            const resp = await wallet.listOutputs({ basket: basketName, limit: 10000 });
            setBasketResult(String(resp.outputs.reduce((a, e) => a + e.satoshis, 0)));
        } catch (err) {
            console.error(err);
        }
    };

    const handleGetHeaderForHeight = async () => {
        if (!wallet) return;
        try {
            const h = parseInt(headerHeight, 10);
            const resp = await wallet.getHeaderForHeight({ height: h });
            setHeaderResult(resp.header);
        } catch (err) {
            console.error(err);
        }
    };

    const handleGetNetwork = async () => {
        if (!wallet) return;
        try {
            const resp = await wallet.getNetwork({});
            setNetworkResult(resp.network);
        } catch (err) {
            console.error(err);
        }
    };

    const handleGetVersion = async () => {
        if (!wallet) return;
        try {
            const resp = await wallet.getVersion({});
            setVersionResult(resp.version);
        } catch (err) {
            console.error(err);
        }
    };

    const handleGetPrivateKey = async () => {
        try {
            const activeConfigId = getActiveConfigId();
            if (!activeConfigId) {
                setPrivateKey('No active config found');
                return;
            }
            const config = getConfigById(activeConfigId);
            if (!config) {
                setPrivateKey('Active config not found in storage');
                return;
            }
            setPrivateKey(config.privateKey);
        } catch (err) {
            console.error(err);
            setPrivateKey('Error retrieving private key');
        }
    }


    return (
        <Box>
            <Typography variant="h4" gutterBottom>Utilities</Typography>
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <Button variant="contained" onClick={handleCheckAuth}>
                        Is Authenticated?
                    </Button>
                    <Button variant="contained" onClick={handleWaitAuth}>
                        Wait For Authentication
                    </Button>
                    <Typography>Status: {authStatus}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <TextField
                        label="Basket Name"
                        value={basketName}
                        onChange={(e) => setBasketName(e.target.value)}
                        sx={{ width: 200 }}
                    />
                    <Button variant="contained" onClick={handleComputeValueForBasket}>
                        Compute Satoshi Value in Basket
                    </Button>
                    <Typography>Satoshis in Basket: {basketResult}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <Button variant="contained" onClick={handleGetHeight}>
                        Get Height
                    </Button>
                    <Typography>Result: {heightResult}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <TextField
                        label="Block Height"
                        value={headerHeight}
                        onChange={(e) => setHeaderHeight(e.target.value)}
                        sx={{ width: 140 }}
                    />
                    <Button variant="contained" onClick={handleGetHeaderForHeight}>
                        Get Header For Height
                    </Button>
                    <Typography>Header: {headerResult}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <Button variant="contained" onClick={handleGetNetwork}>
                        Get Network
                    </Button>
                    <Typography>Result: {networkResult}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <Button variant="contained" onClick={handleGetVersion}>
                        Get Version
                    </Button>
                    <Typography>Result: {versionResult}</Typography>
                </Stack>
            </Paper>
            <Paper sx={{ p: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <Button variant="contained" onClick={handleGetPrivateKey}>
                        Get Private Key
                    </Button>
                    <Typography>Result: {privateKey}</Typography>
                </Stack>
            </Paper>
        </Box>
    );
}

export default UtilitiesPage;
