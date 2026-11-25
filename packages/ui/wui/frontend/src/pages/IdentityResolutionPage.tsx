import { useState } from 'react';
import {
    Box,
    Typography,
    Paper,
    Tabs,
    Tab,
    Stack,
    TextField,
    Button,
    List,
    ListItem,
    ListItemText,
    Pagination,
    Alert,
    IconButton
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { useWallet } from '../contexts/WalletContext';

interface AttributePair {
    name: string;
    value: string;
}

function IdentityResolutionPage() {
    const [tab, setTab] = useState<'key' | 'attrs'>('key');

    return (
        <Box>
            <Typography variant="h4" gutterBottom>
                Identity Resolution
            </Typography>
            <Paper sx={{ p: 2 }}>
                <Tabs value={tab} onChange={(_, v) => setTab(v)}>
                    <Tab label="By Identity Key" value="key" />
                    <Tab label="By Attributes" value="attrs" />
                </Tabs>
                {tab === 'key' && <DiscoverByKey />}
                {tab === 'attrs' && <DiscoverByAttrs />}
            </Paper>
        </Box>
    );
}

/************************************************
 * DiscoverByKey
 ************************************************/
function DiscoverByKey() {
    const { wallet } = useWallet();
    const [identityKey, setIdentityKey] = useState('');
    const [limit, setLimit] = useState(5);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [results, setResults] = useState<any[]>([]);
    const [total, setTotal] = useState(0);

    async function doDiscover(pageNum: number) {
        if (!wallet) return;
        if (!identityKey.trim()) {
            setError('Must provide an identity key');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const resp = await wallet.discoverByIdentityKey({
                identityKey: identityKey.trim(),
                limit,
                offset: (pageNum - 1) * limit
            });
            setResults(resp.certificates || []);
            setTotal(resp.totalCertificates || 0);
        } catch (err: any) {
            setError(err?.message || String(err));
        } finally {
            setLoading(false);
        }
    }

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1">Discover By Identity Key</Typography>
            {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
                <TextField
                    label="Identity Key (pubkey hex)"
                    value={identityKey}
                    onChange={(e) => setIdentityKey(e.target.value)}
                />
                <Button
                    variant="outlined"
                    onClick={() => {
                        setPage(1);
                        doDiscover(1);
                    }}
                >
                    Discover
                </Button>
                <TextField
                    label="Limit"
                    type="number"
                    size="small"
                    sx={{ width: 100 }}
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
                />
            </Stack>

            <Paper sx={{ p: 2, mt: 2 }}>
                {loading && <Typography>Loading...</Typography>}
                {(!loading && !error && results.length === 0) && (
                    <Typography>No certificates found.</Typography>
                )}
                <List>
                    {results.map((r, i) => (
                        <ListItem
                            key={i}
                            sx={{ borderBottom: '1px solid #eee', display: 'block' }}
                        >
                            <ListItemText
                                primary={`Serial: ${r.serialNumber}`}
                                secondary={
                                    <>
                                        Subject: {r.subject} <br />
                                        Type: {r.type}, Certifier: {r.certifier} <br />
                                        RevocationOutpoint: {r.revocationOutpoint} <br />
                                        Fields: {JSON.stringify(r.fields)} <br />
                                        DecryptedFields: {JSON.stringify(r.decryptedFields)} <br />
                                        PubliclyRevealedKeyring: {JSON.stringify(r.publiclyRevealedKeyring)}
                                    </>
                                }
                            />
                        </ListItem>
                    ))}
                </List>
                {results.length > 0 && (
                    <Pagination
                        sx={{ mt: 2 }}
                        page={page}
                        count={Math.ceil(total / limit)}
                        onChange={(_, val) => {
                            setPage(val);
                            doDiscover(val);
                        }}
                    />
                )}
            </Paper>
        </Box>
    );
}

/************************************************
 * DiscoverByAttrs
 ************************************************/
function DiscoverByAttrs() {
    const { wallet } = useWallet();
    const [attrs, setAttrs] = useState<AttributePair[]>([]);
    const [limit, setLimit] = useState(5);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [results, setResults] = useState<any[]>([]);
    const [total, setTotal] = useState(0);

    function addAttr() {
        setAttrs((prev) => [...prev, { name: '', value: '' }]);
    }
    function removeAttr(idx: number) {
        setAttrs((prev) => prev.filter((_, i) => i !== idx));
    }

    async function doDiscover(pageNum: number) {
        if (!wallet) return;
        setLoading(true);
        setError('');
        try {
            const obj: Record<string, string> = {};
            attrs.forEach((a) => {
                if (a.name.trim()) {
                    obj[a.name.trim()] = a.value.trim();
                }
            });
            if (!Object.keys(obj).length) {
                throw new Error('No attributes specified');
            }

            const resp = await wallet.discoverByAttributes({
                attributes: obj,
                limit,
                offset: (pageNum - 1) * limit
            });
            setResults(resp.certificates || []);
            setTotal(resp.totalCertificates || 0);
        } catch (err: any) {
            setError(err?.message || String(err));
        } finally {
            setLoading(false);
        }
    }

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1">Discover By Attributes</Typography>
            {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
            <Paper sx={{ p: 2, mt: 2 }}>
                {attrs.map((a, idx) => (
                    <Stack direction="row" spacing={1} key={idx} sx={{ mb: 1 }}>
                        <TextField
                            label="Attribute Name"
                            size="small"
                            value={a.name}
                            onChange={(e) => {
                                const val = e.target.value;
                                setAttrs((prev) => {
                                    const newArr = [...prev];
                                    newArr[idx] = { ...newArr[idx], name: val };
                                    return newArr;
                                });
                            }}
                        />
                        <TextField
                            label="Attribute Value"
                            size="small"
                            value={a.value}
                            onChange={(e) => {
                                const val = e.target.value;
                                setAttrs((prev) => {
                                    const newArr = [...prev];
                                    newArr[idx] = { ...newArr[idx], value: val };
                                    return newArr;
                                });
                            }}
                        />
                        <IconButton
                            color="warning"
                            onClick={() => removeAttr(idx)}
                        >
                            <DeleteIcon />
                        </IconButton>
                    </Stack>
                ))}
                <Button
                    variant="outlined"
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={addAttr}
                >
                    Add Attribute
                </Button>
            </Paper>

            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
                <TextField
                    label="Limit"
                    type="number"
                    size="small"
                    sx={{ width: 100 }}
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
                />
                <Button
                    variant="outlined"
                    onClick={() => {
                        setPage(1);
                        doDiscover(1);
                    }}
                >
                    Discover
                </Button>
            </Stack>

            <Paper sx={{ p: 2, mt: 2 }}>
                {loading && <Typography>Loading...</Typography>}
                {(!loading && !error && results.length === 0) && (
                    <Typography>No certificates found.</Typography>
                )}
                <List>
                    {results.map((r, i) => (
                        <ListItem
                            key={i}
                            sx={{ borderBottom: '1px solid #eee', display: 'block' }}
                        >
                            <ListItemText
                                primary={`Serial: ${r.serialNumber}`}
                                secondary={
                                    <>
                                        Subject: {r.subject} <br />
                                        Type: {r.type}, Certifier: {r.certifier} <br />
                                        RevocationOutpoint: {r.revocationOutpoint} <br />
                                        Fields: {JSON.stringify(r.fields)} <br />
                                        DecryptedFields: {JSON.stringify(r.decryptedFields)} <br />
                                        PubliclyRevealedKeyring: {JSON.stringify(r.publiclyRevealedKeyring)}
                                    </>
                                }
                            />
                        </ListItem>
                    ))}
                </List>
                {results.length > 0 && (
                    <Pagination
                        sx={{ mt: 2 }}
                        page={page}
                        count={Math.ceil(total / limit)}
                        onChange={(_, val) => {
                            setPage(val);
                            doDiscover(val);
                        }}
                    />
                )}
            </Paper>
        </Box>
    );
}

export default IdentityResolutionPage;
