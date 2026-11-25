import React, { useEffect, useState } from 'react';
import {
    Box,
    Typography,
    Paper,
    Button,
    TextField,
    Divider,
    Checkbox,
    FormControlLabel,
    Stack,
    Pagination,
    Grid,
    MenuItem,
    Select,
    InputLabel,
    FormControl,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Alert, Accordion,
    AccordionSummary,
    AccordionDetails,
    Chip,
    Tooltip,
    IconButton
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import InputIcon from '@mui/icons-material/Input';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import { useWallet } from '../contexts/WalletContext';

/** Helper: copy string to clipboard */
function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch((err) => console.error(err));
}

/** Helper: shortens a TXID for display (e.g., first 8 + '...' + last 8) */
function shortTxid(txid: string) {
    if (txid.length <= 16) return txid;
    return txid.slice(0, 8) + '...' + txid.slice(-8);
}

/** (Optional) You can color-code your status strings if you wish. */
function getStatusColor(status: string): 'default' | 'primary' | 'success' | 'error' | 'warning' {
    const normalized = status.toLowerCase();
    switch (normalized) {
        case 'confirmed':
        case 'success':
            return 'success';
        case 'pending':
        case 'processing':
            return 'warning';
        case 'failed':
        case 'rejected':
            return 'error';
        default:
            return 'default';
    }
}

interface ActionItem {
    txid: string;
    satoshis: number;
    status: string;
    isOutgoing: boolean;
    description: string;
    labels?: string[];
    version?: number;
    lockTime?: number;
    inputs?: Array<{
        sourceOutpoint: string;
        sourceSatoshis: number;
        sourceLockingScript?: string;
        unlockingScript?: string;
        inputDescription: string;
        sequenceNumber: number;
    }>;
    outputs?: Array<{
        outputIndex: number;
        satoshis: number;
        lockingScript?: string;
        spendable: boolean;
        outputDescription: string;
        basket?: string;
        tags?: string[];
        customInstructions?: string;
    }>;
}

// For createAction flows
interface CreateActionInputs {
    description: string;
    inputBEEFHex: string; // raw BEEF hex for input contexts if needed
    inputs: Array<{
        outpoint: string;
        unlockingScript?: string;
        unlockingScriptLength?: number;
        inputDescription: string;
        sequenceNumber?: number;
    }>;
    outputs: Array<{
        lockingScript: string;
        satoshis: number;
        outputDescription: string;
        basket?: string;
        customInstructions?: string;
        tags?: string[];
    }>;
    lockTime?: number;
    version?: number;
    labels?: string[];
    options: {
        signAndProcess: boolean;
        acceptDelayedBroadcast: boolean;
        trustSelf?: 'known'; // possible
        knownTxids?: string[];
        returnTXIDOnly: boolean;
        noSend: boolean;
        noSendChange?: string[];
        sendWith?: string[];
        randomizeOutputs: boolean;
    };
}

// For internalizeAction flows
interface InternalizeOutput {
    outputIndex: number;
    protocol: 'wallet payment' | 'basket insertion';
    paymentRemittance?: {
        derivationPrefix: string; // base64
        derivationSuffix: string; // base64
        senderIdentityKey: string; // pubkey hex
    };
    insertionRemittance?: {
        basket: string;
        customInstructions?: string;
        tags?: string[];
    };
}

function ActionsPage() {
    const { wallet } = useWallet();

    /**************************************************
     * List Filters & State
     **************************************************/
    const [labelsFilter, setLabelsFilter] = useState<string>('');
    const [labelQueryMode, setLabelQueryMode] = useState<'any' | 'all'>('any');
    const [includeLabels, setIncludeLabels] = useState(false);
    const [includeInputs, setIncludeInputs] = useState(false);
    const [includeOutputs, setIncludeOutputs] = useState(false);
    const [limit, setLimit] = useState(5);
    const [actionsPage, setActionsPage] = useState(1);
    const [actions, setActions] = useState<ActionItem[]>([]);
    const [totalActions, setTotalActions] = useState(0);
    const [loadingList, setLoadingList] = useState(false);
    const [listError, setListError] = useState<string>('');

    /**************************************************
     * CREATE ACTION Modal (Multi-Step)
     **************************************************/
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [createData, setCreateData] = useState<CreateActionInputs>({
        description: '',
        inputBEEFHex: '',
        inputs: [],
        outputs: [],
        lockTime: undefined,
        version: undefined,
        labels: [],
        options: {
            signAndProcess: true,
            acceptDelayedBroadcast: true,
            returnTXIDOnly: false,
            noSend: false,
            randomizeOutputs: true
        }
    });
    const [createStep, setCreateStep] = useState<'form' | 'signing' | 'result'>('form');
    const [createResult, setCreateResult] = useState<any>(null);
    const [createLoading, setCreateLoading] = useState(false);
    const [createError, setCreateError] = useState<string>('');

    // For "signing" sub-step (when createAction returns signableTransaction):
    const [signSpendsJson, setSignSpendsJson] = useState('{}');
    const [signLoading, setSignLoading] = useState(false);
    const [abortLoading, setAbortLoading] = useState(false);
    const [signError, setSignError] = useState('');

    /**************************************************
     * INTERNALIZE ACTION Modal
     **************************************************/
    const [internalizeModalOpen, setInternalizeModalOpen] = useState(false);
    const [internalizeTxHex, setInternalizeTxHex] = useState('');
    const [internalizeDescription, setInternalizeDescription] = useState('');
    const [internalizeOutputs, setInternalizeOutputs] = useState<InternalizeOutput[]>([]);
    const [internalizeLoading, setInternalizeLoading] = useState(false);
    const [internalizeError, setInternalizeError] = useState('');
    const [internalizeResult, setInternalizeResult] = useState<any>(null);

    /**************************************************
     * useEffect: load the list initially
     **************************************************/
    useEffect(() => {
        if (!wallet) return;
        fetchActions(actionsPage);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wallet, actionsPage, limit, includeLabels, includeInputs, includeOutputs, labelQueryMode]);

    /**************************************************
     * Fetch / list actions
     **************************************************/
    async function fetchActions(page: number) {
        if (!wallet) return;
        setLoadingList(true);
        setListError('');
        try {
            const labelArray = labelsFilter
                ? labelsFilter.split(',').map((l) => l.trim()).filter(Boolean)
                : [];
            const resp = await wallet.listActions({
                labels: labelArray,
                labelQueryMode,
                includeLabels,
                includeInputs,
                includeOutputs,
                includeInputUnlockingScripts: true,
                includeInputSourceLockingScripts: true,
                includeOutputLockingScripts: true,
                limit,
                offset: (page - 1) * limit
            });
            setActions(resp.actions || []);
            setTotalActions(resp.totalActions || 0);
        } catch (err: any) {
            console.error('listActions error:', err);
            setListError(err?.message || String(err));
        } finally {
            setLoadingList(false);
        }
    }

    /**************************************************
     * Create Action Flow
     **************************************************/
    function handleOpenCreateModal() {
        setCreateModalOpen(true);
        setCreateStep('form');
        // Reset everything
        setCreateData({
            description: '',
            inputBEEFHex: '',
            inputs: [],
            outputs: [],
            lockTime: undefined,
            version: undefined,
            labels: [],
            options: {
                signAndProcess: true,
                acceptDelayedBroadcast: true,
                returnTXIDOnly: false,
                noSend: false,
                randomizeOutputs: true
            }
        });
        setCreateResult(null);
        setCreateError('');
    }

    function handleCloseCreateModal() {
        setCreateModalOpen(false);
    }

    async function doCreateAction() {
        if (!wallet) return;
        setCreateLoading(true);
        setCreateError('');
        setCreateStep('form');
        setCreateResult(null);
        try {
            const resp = await wallet.createAction({
                description: createData.description,
                inputBEEF: createData.inputBEEFHex ? parseHexString(createData.inputBEEFHex) : undefined,
                inputs: createData.inputs,
                outputs: createData.outputs,
                lockTime: createData.lockTime,
                version: createData.version,
                labels: createData.labels,
                options: {
                    trustSelf: 'known',
                    ...createData.options
                }
            });
            setCreateResult(resp);

            // If there's a signableTransaction, we go to the "signing" step
            if (resp?.signableTransaction) {
                setCreateStep('signing');
            } else {
                // no sign needed, show final result
                setCreateStep('result');
            }
            // refresh the list
            fetchActions(actionsPage);
        } catch (err: any) {
            console.error('createAction error:', err);
            setCreateError(err?.message || String(err));
        } finally {
            setCreateLoading(false);
        }
    }

    /** sign the transaction from createAction’s result */
    async function doSignAction() {
        if (!wallet || !createResult?.signableTransaction) return;
        setSignLoading(true);
        setSignError('');
        try {
            const parsedSpends = JSON.parse(signSpendsJson);
            const resp = await wallet.signAction({
                reference: createResult.signableTransaction.reference,
                spends: parsedSpends
            });
            setCreateResult(resp);
            setCreateStep('result');
            // refresh
            fetchActions(actionsPage);
        } catch (err: any) {
            console.error('signAction error:', err);
            setSignError(err?.message || String(err));
        } finally {
            setSignLoading(false);
        }
    }

    /** abort the partially created action */
    async function doAbortAction() {
        if (!wallet || !createResult?.signableTransaction) return;
        setAbortLoading(true);
        setSignError('');
        try {
            const ref = createResult.signableTransaction.reference;
            const resp = await wallet.abortAction({ reference: ref });
            console.log('abortAction result:', resp);
            setCreateStep('result');
            setCreateResult(resp);
            // refresh
            fetchActions(actionsPage);
        } catch (err: any) {
            console.error('abortAction error:', err);
            setSignError(err?.message || String(err));
        } finally {
            setAbortLoading(false);
        }
    }

    /**************************************************
     * Internalize Action Flow
     **************************************************/
    function handleOpenInternalizeModal() {
        setInternalizeModalOpen(true);
        setInternalizeTxHex('');
        setInternalizeDescription('');
        setInternalizeOutputs([]);
        setInternalizeLoading(false);
        setInternalizeError('');
        setInternalizeResult(null);
    }

    function handleCloseInternalizeModal() {
        setInternalizeModalOpen(false);
    }

    function addInternalizeOutput() {
        setInternalizeOutputs((prev) => [
            ...prev,
            {
                outputIndex: 0,
                protocol: 'wallet payment',
                paymentRemittance: {
                    derivationPrefix: '',
                    derivationSuffix: '',
                    senderIdentityKey: ''
                }
            }
        ]);
    }

    async function doInternalize() {
        if (!wallet) return;
        setInternalizeLoading(true);
        setInternalizeError('');
        setInternalizeResult(null);
        try {
            // parse the AtomicBEEF from hex
            const txBytes = parseHexString(internalizeTxHex);
            const resp = await wallet.internalizeAction({
                tx: txBytes,
                outputs: internalizeOutputs,
                description: internalizeDescription
            });
            setInternalizeResult(resp);
            // Refresh
            fetchActions(actionsPage);
        } catch (err: any) {
            console.error('internalizeAction error:', err);
            setInternalizeError(err?.message || String(err));
        } finally {
            setInternalizeLoading(false);
        }
    }

    /**************************************************
     * Utility
     **************************************************/
    function parseHexString(hex: string): number[] {
        const clean = hex.replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '');
        const result: number[] = [];
        for (let i = 0; i < clean.length; i += 2) {
            result.push(parseInt(clean.substr(i, 2), 16));
        }
        return result;
    }

    function bytesToHex(arr: number[]): string {
        return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**************************************************
     * Render
     **************************************************/
    return (
        <Box>
            <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                justifyContent="space-between"
                sx={{ mb: 2 }}
            >
                <Typography variant="h4" gutterBottom>
                    Actions
                </Typography>
                {/* Actions on the top right */}
                <Stack direction="row" spacing={2}>
                    <Button
                        startIcon={<InputIcon />}
                        variant="outlined"
                        onClick={handleOpenInternalizeModal}
                    >
                        Internalize
                    </Button>
                    <Button
                        startIcon={<AddIcon />}
                        variant="contained"
                        onClick={handleOpenCreateModal}
                    >
                        Create Action
                    </Button>
                </Stack>
            </Stack>

            {/* Filters */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Typography variant="subtitle1">Filters</Typography>
                <Grid container spacing={2} alignItems="center" sx={{ mt: 1 }}>
                    <Grid item xs={12} sm={3}>
                        <TextField
                            label="Labels (comma-separated)"
                            value={labelsFilter || ''}
                            onChange={(e) => setLabelsFilter(e.target.value)}
                            fullWidth
                        />
                    </Grid>
                    <Grid item xs={12} sm={3}>
                        <FormControl fullWidth>
                            <InputLabel>Label Query Mode</InputLabel>
                            <Select
                                label="Label Query Mode"
                                value={labelQueryMode}
                                onChange={(e) =>
                                    setLabelQueryMode(e.target.value as 'any' | 'all')
                                }
                            >
                                <MenuItem value="any">Any</MenuItem>
                                <MenuItem value="all">All</MenuItem>
                            </Select>
                        </FormControl>
                    </Grid>
                    <Grid item xs={6} sm={2}>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={includeLabels}
                                    onChange={(e) => setIncludeLabels(e.target.checked)}
                                />
                            }
                            label="Include Labels"
                        />
                    </Grid>
                    <Grid item xs={6} sm={2}>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={includeInputs}
                                    onChange={(e) => setIncludeInputs(e.target.checked)}
                                />
                            }
                            label="Include Inputs"
                        />
                    </Grid>
                    <Grid item xs={6} sm={2}>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={includeOutputs}
                                    onChange={(e) => setIncludeOutputs(e.target.checked)}
                                />
                            }
                            label="Include Outputs"
                        />
                    </Grid>
                </Grid>
                <Box textAlign="right" sx={{ mt: 2 }}>
                    <Button
                        variant="outlined"
                        onClick={() => {
                            setActionsPage(1);
                            fetchActions(1);
                        }}
                    >
                        Apply Filters
                    </Button>
                </Box>
            </Paper>

            {/* List */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">Action List</Typography>
                    <FormControl size="small" sx={{ width: 100 }}>
                        <InputLabel>Limit</InputLabel>
                        <Select
                            label="Limit"
                            value={limit}
                            onChange={(e) => {
                                setLimit(Number(e.target.value));
                                setActionsPage(1);
                            }}
                        >
                            <MenuItem value={5}>5</MenuItem>
                            <MenuItem value={10}>10</MenuItem>
                            <MenuItem value={25}>25</MenuItem>
                        </Select>
                    </FormControl>
                </Stack>

                {loadingList && <Typography sx={{ mt: 2 }}>Loading...</Typography>}
                {listError && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                        {listError}
                    </Alert>
                )}

                {/* Render each action in an Accordion for detail expansion */}
                {actions.map((action, idx) => {
                    return (
                        <Accordion key={idx} sx={{ mt: 2 }}>
                            <AccordionSummary
                                expandIcon={<ExpandMoreIcon />}
                                aria-controls={`panel-${idx}-content`}
                                id={`panel-${idx}-header`}
                            >
                                {/* Top (summary) row: TXID (short), description, status, satoshis */}
                                <Box sx={{ width: '100%' }}>
                                    <Stack
                                        direction={{ xs: 'column', sm: 'row' }}
                                        spacing={1}
                                        alignItems={{ xs: 'flex-start', sm: 'center' }}
                                        justifyContent="space-between"
                                    >
                                        {/* Left side: TxID + Description */}
                                        <Stack direction="row" spacing={1} alignItems="center">
                                            <Typography variant="body1" fontWeight="bold">
                                                {shortTxid(action.txid)}
                                            </Typography>
                                            {/* Copy button for TXID */}
                                            <Tooltip title="Copy full TXID">
                                                <IconButton
                                                    size="small"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        copyToClipboard(action.txid);
                                                    }}
                                                >
                                                    <ContentCopyIcon fontSize="inherit" />
                                                </IconButton>
                                            </Tooltip>
                                            {action.description && (
                                                <Typography variant="body2" sx={{ ml: 1 }}>
                                                    {`- ${action.description}`}
                                                </Typography>
                                            )}
                                        </Stack>

                                        {/* Right side: Status + Satoshis + Outgoing/Incoming indicator */}
                                        <Stack direction="row" spacing={2} alignItems="center">
                                            {/* Show status as a Chip, possibly color-coded */}
                                            <Chip
                                                label={action.status}
                                                color={getStatusColor(action.status)}
                                                size="small"
                                            />
                                            {action.satoshis !== undefined && (
                                                <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                                                    {action.satoshis} sats
                                                </Typography>
                                            )}
                                            {/* Outgoing or Incoming? */}
                                            <Typography
                                                variant="body2"
                                                color={action.isOutgoing ? 'error' : 'success'}
                                                sx={{ fontWeight: 'bold' }}
                                            >
                                                {action.isOutgoing ? 'Outgoing' : 'Incoming'}
                                            </Typography>
                                        </Stack>
                                    </Stack>
                                </Box>
                            </AccordionSummary>

                            <AccordionDetails>
                                {/* Labels, version, lockTime, etc. */}
                                <Stack spacing={1} sx={{ mb: 1 }}>
                                    {action.labels && action.labels.length > 0 && (
                                        <Box>
                                            <Typography variant="subtitle2">Labels:</Typography>
                                            <Stack direction="row" spacing={1} flexWrap="wrap">
                                                {action.labels.map((label, i) => (
                                                    <Chip key={i} label={label} size="small" variant="outlined" />
                                                ))}
                                            </Stack>
                                        </Box>
                                    )}

                                    {/* Show optional version/lockTime if they exist */}
                                    {(action.version !== undefined || action.lockTime !== undefined) && (
                                        <Box>
                                            <Typography variant="subtitle2">Additional Info:</Typography>
                                            <Stack direction="row" spacing={2}>
                                                {action.version !== undefined && (
                                                    <Typography variant="body2">Version: {action.version}</Typography>
                                                )}
                                                {action.lockTime !== undefined && (
                                                    <Typography variant="body2">Lock Time: {action.lockTime}</Typography>
                                                )}
                                            </Stack>
                                        </Box>
                                    )}
                                </Stack>

                                {/* Inputs */}
                                {includeInputs ? (
                                    action.inputs && action.inputs.length > 0 ? (
                                        <Box sx={{ mb: 2 }}>
                                            <Typography variant="subtitle1" sx={{ mb: 1 }}>
                                                Inputs ({action.inputs.length})
                                            </Typography>
                                            <Grid container spacing={2}>
                                                {action.inputs.map((inp, i) => (
                                                    <Grid item xs={12} key={i}>
                                                        <Paper
                                                            variant="outlined"
                                                            sx={{ p: 2, backgroundColor: '#fafafa' }}
                                                        >
                                                            <Stack spacing={1}>
                                                                <Typography variant="body2">
                                                                    <strong>Outpoint:</strong> {inp.sourceOutpoint}
                                                                </Typography>
                                                                <Typography variant="body2">
                                                                    <strong>Satoshis:</strong> {inp.sourceSatoshis}
                                                                </Typography>
                                                                {inp.inputDescription && (
                                                                    <Typography variant="body2">
                                                                        <strong>Description:</strong> {inp.inputDescription}
                                                                    </Typography>
                                                                )}
                                                                {typeof inp.sequenceNumber === 'number' && (
                                                                    <Typography variant="body2">
                                                                        <strong>Sequence Number:</strong> {inp.sequenceNumber}
                                                                    </Typography>
                                                                )}

                                                                {/* Locking / Unlocking scripts can be large. Put them in scrollable boxes. */}
                                                                {inp.sourceLockingScript && (
                                                                    <Box>
                                                                        <Typography variant="body2" fontWeight="bold">
                                                                            Source Locking Script:
                                                                        </Typography>
                                                                        <Box
                                                                            sx={{
                                                                                maxHeight: 150,
                                                                                overflow: 'auto',
                                                                                backgroundColor: '#f0f0f0',
                                                                                p: 1,
                                                                                mt: 1,
                                                                                fontFamily: 'monospace',
                                                                                fontSize: 14
                                                                            }}
                                                                        >
                                                                            {inp.sourceLockingScript}
                                                                        </Box>
                                                                    </Box>
                                                                )}
                                                                {inp.unlockingScript && (
                                                                    <Box>
                                                                        <Typography variant="body2" fontWeight="bold">
                                                                            Unlocking Script:
                                                                        </Typography>
                                                                        <Box
                                                                            sx={{
                                                                                maxHeight: 150,
                                                                                overflow: 'auto',
                                                                                backgroundColor: '#f0f0f0',
                                                                                p: 1,
                                                                                mt: 1,
                                                                                fontFamily: 'monospace',
                                                                                fontSize: 14
                                                                            }}
                                                                        >
                                                                            {inp.unlockingScript}
                                                                        </Box>
                                                                    </Box>
                                                                )}
                                                            </Stack>
                                                        </Paper>
                                                    </Grid>
                                                ))}
                                            </Grid>
                                        </Box>
                                    ) : (
                                        <Typography variant="body2" sx={{ mb: 2 }}>
                                            No inputs for this action.
                                        </Typography>
                                    )
                                ) : (
                                    <Typography variant="body2" sx={{ mb: 2 }}>
                                        Inputs not requested. Enable “Include Inputs” to see them.
                                    </Typography>
                                )}

                                {/* Outputs */}
                                {includeOutputs ? (
                                    action.outputs && action.outputs.length > 0 ? (
                                        <Box sx={{ mb: 1 }}>
                                            <Typography variant="subtitle1" sx={{ mb: 1 }}>
                                                Outputs ({action.outputs.length})
                                            </Typography>
                                            <Grid container spacing={2}>
                                                {action.outputs.map((out, i) => (
                                                    <Grid item xs={12} key={i}>
                                                        <Paper
                                                            variant="outlined"
                                                            sx={{ p: 2, backgroundColor: '#fafafa' }}
                                                        >
                                                            <Stack spacing={1}>
                                                                <Typography variant="body2">
                                                                    <strong>Output Index:</strong> {out.outputIndex}
                                                                </Typography>
                                                                <Typography variant="body2">
                                                                    <strong>Satoshis:</strong> {out.satoshis}
                                                                </Typography>
                                                                {out.outputDescription && (
                                                                    <Typography variant="body2">
                                                                        <strong>Description:</strong> {out.outputDescription}
                                                                    </Typography>
                                                                )}

                                                                <Typography variant="body2">
                                                                    <strong>Spendable:</strong>{' '}
                                                                    {out.spendable ? 'Yes' : 'No'}
                                                                </Typography>

                                                                {/* If a basket is present */}
                                                                {out.basket && (
                                                                    <Typography variant="body2">
                                                                        <strong>Basket:</strong> {out.basket}
                                                                    </Typography>
                                                                )}

                                                                {/* Tags if present */}
                                                                {out.tags && out.tags.length > 0 && (
                                                                    <Box>
                                                                        <Typography variant="body2" fontWeight="bold">
                                                                            Tags:
                                                                        </Typography>
                                                                        <Stack direction="row" spacing={1} flexWrap="wrap">
                                                                            {out.tags.map((t, tagIdx) => (
                                                                                <Chip key={tagIdx} label={t} size="small" />
                                                                            ))}
                                                                        </Stack>
                                                                    </Box>
                                                                )}

                                                                {/* Custom instructions if present */}
                                                                {out.customInstructions && (
                                                                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                                                                        <strong>Custom Instructions:</strong>{' '}
                                                                        {out.customInstructions}
                                                                    </Typography>
                                                                )}

                                                                {/* Locking script can be large. */}
                                                                {out.lockingScript && (
                                                                    <Box>
                                                                        <Typography variant="body2" fontWeight="bold">
                                                                            Locking Script:
                                                                        </Typography>
                                                                        <Box
                                                                            sx={{
                                                                                maxHeight: 150,
                                                                                overflow: 'auto',
                                                                                backgroundColor: '#f0f0f0',
                                                                                p: 1,
                                                                                mt: 1,
                                                                                fontFamily: 'monospace',
                                                                                fontSize: 14
                                                                            }}
                                                                        >
                                                                            {out.lockingScript}
                                                                        </Box>
                                                                    </Box>
                                                                )}
                                                            </Stack>
                                                        </Paper>
                                                    </Grid>
                                                ))}
                                            </Grid>
                                        </Box>
                                    ) : (
                                        <Typography variant="body2" sx={{ mb: 1 }}>
                                            No outputs for this action.
                                        </Typography>
                                    )
                                ) : (
                                    <Typography variant="body2" sx={{ mb: 2 }}>
                                        Outputs not requested. Enable “Include Outputs” to see them.
                                    </Typography>
                                )}
                            </AccordionDetails>
                        </Accordion>
                    );
                })}

                {/* Pagination */}
                <Pagination
                    sx={{ mt: 2 }}
                    page={actionsPage}
                    count={Math.ceil(totalActions / limit)}
                    onChange={(_, val) => {
                        setActionsPage(val);
                    }}
                />
            </Paper>

            {/** CREATE ACTION MODAL */}
            <Dialog
                open={createModalOpen}
                onClose={handleCloseCreateModal}
                fullWidth
                maxWidth="lg"
            >
                <DialogTitle>Create Action</DialogTitle>
                <DialogContent>
                    {createStep === 'form' && (
                        <CreateActionFormContent
                            createData={createData}
                            setCreateData={setCreateData}
                            createLoading={createLoading}
                            createError={createError}
                        />
                    )}

                    {createStep === 'signing' && (
                        <Box sx={{ mt: 1 }}>
                            <Typography variant="subtitle1">Signing Phase</Typography>
                            <Typography variant="body2" sx={{ mt: 1 }}>
                                Reference: {createResult?.signableTransaction?.reference}
                            </Typography>
                            <Typography variant="body2" sx={{ mt: 1 }}>
                                Atomic BEEF (Hex):
                            </Typography>
                            <Box
                                sx={{
                                    mt: 1,
                                    background: '#f5f5f5',
                                    p: 1,
                                    maxHeight: 200,
                                    overflow: 'auto'
                                }}
                            >
                                {createResult?.signableTransaction?.tx
                                    ? bytesToHex(createResult.signableTransaction.tx)
                                    : ''}
                            </Box>
                            <TextField
                                label="Spends (JSON)"
                                multiline
                                rows={4}
                                fullWidth
                                sx={{ mt: 2 }}
                                value={signSpendsJson}
                                onChange={(e) => setSignSpendsJson(e.target.value)}
                            />
                            {signError && (
                                <Alert severity="error" sx={{ mt: 1 }}>
                                    {signError}
                                </Alert>
                            )}
                        </Box>
                    )}

                    {createStep === 'result' && (
                        <Box sx={{ mt: 1 }}>
                            <Typography variant="subtitle1">Result</Typography>
                            <Box
                                sx={{
                                    mt: 1,
                                    background: '#f5f5f5',
                                    p: 1,
                                    maxHeight: 300,
                                    overflow: 'auto'
                                }}
                            >
                                <pre>{JSON.stringify(createResult, null, 2)}</pre>
                            </Box>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    {createStep === 'form' && (
                        <>
                            {createError && (
                                <Alert severity="error" sx={{ mr: 2, flex: 1 }}>
                                    {createError}
                                </Alert>
                            )}
                            <Button onClick={handleCloseCreateModal} disabled={createLoading}>
                                Cancel
                            </Button>
                            <Button
                                variant="contained"
                                onClick={doCreateAction}
                                disabled={createLoading}
                            >
                                {createLoading ? 'Creating...' : 'Create'}
                            </Button>
                        </>
                    )}
                    {createStep === 'signing' && (
                        <>
                            {signError && (
                                <Alert severity="error" sx={{ mr: 2, flex: 1 }}>
                                    {signError}
                                </Alert>
                            )}
                            <Button onClick={handleCloseCreateModal} disabled={signLoading || abortLoading}>
                                Close
                            </Button>
                            <Button
                                variant="outlined"
                                color="warning"
                                onClick={doAbortAction}
                                disabled={signLoading || abortLoading}
                            >
                                {abortLoading ? 'Aborting...' : 'Abort'}
                            </Button>
                            <Button
                                variant="contained"
                                onClick={doSignAction}
                                disabled={signLoading || abortLoading}
                            >
                                {signLoading ? 'Signing...' : 'Sign'}
                            </Button>
                        </>
                    )}
                    {createStep === 'result' && (
                        <>
                            <Button variant="contained" onClick={handleCloseCreateModal}>
                                Close
                            </Button>
                        </>
                    )}
                </DialogActions>
            </Dialog>

            {/** INTERNALIZE ACTION MODAL */}
            <Dialog
                open={internalizeModalOpen}
                onClose={handleCloseInternalizeModal}
                fullWidth
                maxWidth="lg"
            >
                <DialogTitle>Internalize Action</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        {internalizeError && <Alert severity="error">{internalizeError}</Alert>}
                        <TextField
                            label="Atomic BEEF (Hex)"
                            multiline
                            rows={4}
                            value={internalizeTxHex}
                            onChange={(e) => setInternalizeTxHex(e.target.value)}
                            fullWidth
                        />
                        <TextField
                            label="Description"
                            value={internalizeDescription}
                            onChange={(e) => setInternalizeDescription(e.target.value)}
                            fullWidth
                        />

                        <Typography variant="subtitle2">Outputs</Typography>
                        {internalizeOutputs.map((o, idx) => (
                            <Box
                                key={idx}
                                sx={{
                                    p: 1,
                                    background: '#f7f7f7',
                                    mb: 1,
                                    borderRadius: 1,
                                    border: '1px solid #ccc'
                                }}
                            >
                                <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
                                    <TextField
                                        label="Output Index"
                                        type="number"
                                        sx={{ width: 120 }}
                                        value={o.outputIndex}
                                        onChange={(e) => {
                                            const val = parseInt(e.target.value, 10) || 0;
                                            updateInternalizeOutput(idx, { outputIndex: val });
                                        }}
                                    />
                                    <FormControl>
                                        <InputLabel>Protocol</InputLabel>
                                        <Select
                                            value={o.protocol}
                                            label="Protocol"
                                            onChange={(e) => {
                                                const protocol = e.target.value as
                                                    | 'wallet payment'
                                                    | 'basket insertion';
                                                updateInternalizeOutput(idx, { protocol });
                                            }}
                                            sx={{ width: 180 }}
                                        >
                                            <MenuItem value="wallet payment">Wallet Payment</MenuItem>
                                            <MenuItem value="basket insertion">Basket Insertion</MenuItem>
                                        </Select>
                                    </FormControl>
                                    <IconButton
                                        color="warning"
                                        onClick={() => removeInternalizeOutput(idx)}
                                    >
                                        <DeleteIcon />
                                    </IconButton>
                                </Stack>

                                {o.protocol === 'wallet payment' && (
                                    <Stack direction="column" spacing={1}>
                                        <TextField
                                            label="Sender Identity Key (PubKey Hex)"
                                            value={o.paymentRemittance?.senderIdentityKey || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    paymentRemittance: {
                                                        ...o.paymentRemittance!,
                                                        senderIdentityKey: e.target.value
                                                    }
                                                })
                                            }
                                        />
                                        <TextField
                                            label="Derivation Prefix (Base64)"
                                            value={o.paymentRemittance?.derivationPrefix || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    paymentRemittance: {
                                                        ...o.paymentRemittance!,
                                                        derivationPrefix: e.target.value
                                                    }
                                                })
                                            }
                                        />
                                        <TextField
                                            label="Derivation Suffix (Base64)"
                                            value={o.paymentRemittance?.derivationSuffix || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    paymentRemittance: {
                                                        ...o.paymentRemittance!,
                                                        derivationSuffix: e.target.value
                                                    }
                                                })
                                            }
                                        />
                                    </Stack>
                                )}

                                {o.protocol === 'basket insertion' && (
                                    <Stack direction="column" spacing={1}>
                                        <TextField
                                            label="Basket"
                                            value={o.insertionRemittance?.basket || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    insertionRemittance: {
                                                        ...o.insertionRemittance,
                                                        basket: e.target.value
                                                    }
                                                })
                                            }
                                        />
                                        <TextField
                                            label="Custom Instructions"
                                            value={o.insertionRemittance?.customInstructions || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    insertionRemittance: {
                                                        ...o.insertionRemittance!,
                                                        customInstructions: e.target.value
                                                    }
                                                })
                                            }
                                        />
                                        <TextField
                                            label="Tags (comma-separated)"
                                            value={o.insertionRemittance?.tags?.join(', ') || ''}
                                            onChange={(e) =>
                                                updateInternalizeOutput(idx, {
                                                    insertionRemittance: {
                                                        ...o.insertionRemittance!,
                                                        tags: e.target.value
                                                            .split(',')
                                                            .map((t) => t.trim())
                                                            .filter(Boolean)
                                                    }
                                                })
                                            }
                                        />
                                    </Stack>
                                )}
                            </Box>
                        ))}
                        <Button variant="outlined" onClick={addInternalizeOutput}>
                            Add Output
                        </Button>

                        {internalizeResult && (
                            <Box sx={{ background: '#f5f5f5', p: 1, mt: 1 }}>
                                <Typography variant="subtitle2">Result</Typography>
                                <pre>{JSON.stringify(internalizeResult, null, 2)}</pre>
                            </Box>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleCloseInternalizeModal} disabled={internalizeLoading}>
                        Cancel
                    </Button>
                    <Button
                        variant="contained"
                        onClick={doInternalize}
                        disabled={internalizeLoading}
                    >
                        {internalizeLoading ? 'Processing...' : 'Internalize'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );

    /**************************************************
     * Helper fns for internalize
     **************************************************/
    function updateInternalizeOutput(
        idx: number,
        patch: Partial<InternalizeOutput>
    ) {
        setInternalizeOutputs((prev) => {
            const newArr = [...prev];
            const current = { ...newArr[idx] };
            // If the patch includes nested fields, we do a shallow merge
            if (patch.paymentRemittance) {
                current.paymentRemittance = {
                    ...(current.paymentRemittance || {}),
                    ...patch.paymentRemittance
                };
            }
            if (patch.insertionRemittance) {
                current.insertionRemittance = {
                    ...(current.insertionRemittance || {}),
                    ...patch.insertionRemittance
                };
            }
            // For top-level fields like outputIndex, protocol:
            if (patch.outputIndex !== undefined) {
                current.outputIndex = patch.outputIndex;
            }
            if (patch.protocol !== undefined) {
                current.protocol = patch.protocol;
                // reset the other field in case we switched protocol
                if (patch.protocol === 'wallet payment') {
                    current.paymentRemittance = {
                        derivationPrefix: '',
                        derivationSuffix: '',
                        senderIdentityKey: ''
                    };
                    current.insertionRemittance = undefined;
                } else {
                    current.insertionRemittance = {
                        basket: ''
                    };
                    current.paymentRemittance = undefined;
                }
            }
            newArr[idx] = current;
            return newArr;
        });
    }

    function removeInternalizeOutput(idx: number) {
        setInternalizeOutputs((prev) => {
            const newArr = [...prev];
            newArr.splice(idx, 1);
            return newArr;
        });
    }
}

/**************************************************
 * A sub-component to gather createAction form fields
 * (the "form" step) with dynamic Inputs and Outputs.
 **************************************************/
function CreateActionFormContent(props: {
    createData: CreateActionInputs;
    setCreateData: React.Dispatch<React.SetStateAction<CreateActionInputs>>;
    createLoading: boolean;
    createError: string;
}) {
    const { createData, setCreateData, createLoading, createError } = props;

    // Track if both arrays are empty (for warning at the bottom).
    const bothArraysEmpty =
        createData.inputs.length === 0 && createData.outputs.length === 0;

    /**************************************************
     * Dialog states for Inputs
     **************************************************/
    const [inputDialogOpen, setInputDialogOpen] = useState(false);
    // If editing, store the index; if adding, store null
    const [editingInputIndex, setEditingInputIndex] = useState<number | null>(null);
    const [inputFormState, setInputFormState] = useState({
        outpoint: '',
        inputDescription: '',
        unlockingScript: '',
        unlockingScriptLength: '',
        sequenceNumber: ''
    });

    // Open dialog for adding a new input
    function handleAddInputDialogOpen() {
        setEditingInputIndex(null);
        setInputFormState({
            outpoint: '',
            inputDescription: '',
            unlockingScript: '',
            unlockingScriptLength: '',
            sequenceNumber: ''
        });
        setInputDialogOpen(true);
    }

    // Open dialog for editing an existing input
    function handleEditInputDialogOpen(index: number) {
        const inp = createData.inputs[index];
        setEditingInputIndex(index);
        setInputFormState({
            outpoint: inp.outpoint,
            inputDescription: inp.inputDescription,
            unlockingScript: inp.unlockingScript || '',
            unlockingScriptLength: inp.unlockingScriptLength
                ? String(inp.unlockingScriptLength)
                : '',
            sequenceNumber: inp.sequenceNumber ? String(inp.sequenceNumber) : ''
        });
        setInputDialogOpen(true);
    }

    // Save or update input on dialog confirm
    function handleSaveInput() {
        if (editingInputIndex === null) {
            // This is a new input
            setCreateData((prev) => ({
                ...prev,
                inputs: [
                    ...prev.inputs,
                    {
                        outpoint: inputFormState.outpoint.trim(),
                        inputDescription: inputFormState.inputDescription.trim(),
                        unlockingScript: inputFormState.unlockingScript.trim() || undefined,
                        unlockingScriptLength: inputFormState.unlockingScriptLength
                            ? parseInt(inputFormState.unlockingScriptLength, 10)
                            : undefined,
                        sequenceNumber: inputFormState.sequenceNumber
                            ? parseInt(inputFormState.sequenceNumber, 10)
                            : undefined
                    }
                ]
            }));
        } else {
            // Editing existing input
            setCreateData((prev) => {
                const newInputs = [...prev.inputs];
                newInputs[editingInputIndex] = {
                    outpoint: inputFormState.outpoint.trim(),
                    inputDescription: inputFormState.inputDescription.trim(),
                    unlockingScript: inputFormState.unlockingScript.trim() || undefined,
                    unlockingScriptLength: inputFormState.unlockingScriptLength
                        ? parseInt(inputFormState.unlockingScriptLength, 10)
                        : undefined,
                    sequenceNumber: inputFormState.sequenceNumber
                        ? parseInt(inputFormState.sequenceNumber, 10)
                        : undefined
                };
                return { ...prev, inputs: newInputs };
            });
        }
        setInputDialogOpen(false);
    }

    // Cancel input dialog
    function handleCancelInputDialog() {
        setInputDialogOpen(false);
    }

    // Remove an input
    function removeInput(index: number) {
        setCreateData((prev) => {
            const newArr = [...prev.inputs];
            newArr.splice(index, 1);
            return { ...prev, inputs: newArr };
        });
    }

    /**************************************************
     * Dialog states for Outputs
     **************************************************/
    const [outputDialogOpen, setOutputDialogOpen] = useState(false);
    const [editingOutputIndex, setEditingOutputIndex] = useState<number | null>(
        null
    );
    const [outputFormState, setOutputFormState] = useState({
        lockingScript: '',
        satoshis: '1000',
        outputDescription: '',
        basket: '',
        customInstructions: '',
        tags: ''
    });

    // Open dialog for adding a new output
    function handleAddOutputDialogOpen() {
        setEditingOutputIndex(null);
        setOutputFormState({
            lockingScript: '',
            satoshis: '1000',
            outputDescription: '',
            basket: '',
            customInstructions: '',
            tags: ''
        });
        setOutputDialogOpen(true);
    }

    // Open dialog for editing an existing output
    function handleEditOutputDialogOpen(index: number) {
        const out = createData.outputs[index];
        setEditingOutputIndex(index);
        setOutputFormState({
            lockingScript: out.lockingScript,
            satoshis: String(out.satoshis),
            outputDescription: out.outputDescription,
            basket: out.basket || '',
            customInstructions: out.customInstructions || '',
            tags: out.tags?.join(', ') || ''
        });
        setOutputDialogOpen(true);
    }

    // Save or update output on dialog confirm
    function handleSaveOutput() {
        const newOutput = {
            lockingScript: outputFormState.lockingScript.trim(),
            satoshis: parseInt(outputFormState.satoshis, 10) || 0,
            outputDescription: outputFormState.outputDescription.trim(),
            basket: outputFormState.basket.trim() || undefined,
            customInstructions: outputFormState.customInstructions.trim() || undefined,
            tags: outputFormState.tags
                ? outputFormState.tags
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                : undefined
        };

        if (editingOutputIndex === null) {
            // New output
            setCreateData((prev) => ({
                ...prev,
                outputs: [...prev.outputs, newOutput]
            }));
        } else {
            // Editing existing output
            setCreateData((prev) => {
                const newOutputs = [...prev.outputs];
                newOutputs[editingOutputIndex] = newOutput;
                return { ...prev, outputs: newOutputs };
            });
        }
        setOutputDialogOpen(false);
    }

    // Cancel output dialog
    function handleCancelOutputDialog() {
        setOutputDialogOpen(false);
    }

    // Remove an output
    function removeOutput(index: number) {
        setCreateData((prev) => {
            const newArr = [...prev.outputs];
            newArr.splice(index, 1);
            return { ...prev, outputs: newArr };
        });
    }

    return (
        <Box sx={{ mt: 1 }}>
            {/* Display any top-level error from the parent if present */}
            {createError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {createError}
                </Alert>
            )}

            {/* Basic fields */}
            <Stack spacing={2}>
                {/* Top-Level Description */}
                <TextField
                    label="Action Description"
                    value={createData.description}
                    onChange={(e) =>
                        setCreateData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    disabled={createLoading}
                    fullWidth
                />

                {/* Input BEEF */}
                <TextField
                    label="Input BEEF (Hex)"
                    helperText="Optional: Transaction context for inputs, if needed."
                    multiline
                    rows={2}
                    value={createData.inputBEEFHex}
                    onChange={(e) =>
                        setCreateData((prev) => ({ ...prev, inputBEEFHex: e.target.value }))
                    }
                    disabled={createLoading}
                    fullWidth
                />

                {/* LockTime & Version */}
                <Grid container spacing={2}>
                    <Grid item xs={6}>
                        <TextField
                            label="Lock Time"
                            type="number"
                            value={createData.lockTime || ''}
                            onChange={(e) => {
                                const val = e.target.value
                                    ? parseInt(e.target.value, 10)
                                    : undefined;
                                setCreateData((prev) => ({ ...prev, lockTime: val }));
                            }}
                            fullWidth
                            disabled={createLoading}
                        />
                    </Grid>
                    <Grid item xs={6}>
                        <TextField
                            label="Version"
                            type="number"
                            value={createData.version || ''}
                            onChange={(e) => {
                                const val = e.target.value
                                    ? parseInt(e.target.value, 10)
                                    : undefined;
                                setCreateData((prev) => ({ ...prev, version: val }));
                            }}
                            fullWidth
                            disabled={createLoading}
                        />
                    </Grid>
                </Grid>

                {/* Labels */}
                <TextField
                    label="Labels (comma-separated)"
                    value={createData.labels?.join(', ') || ''}
                    onChange={(e) => {
                        const arr = e.target.value
                            .split(',')
                            .map((l) => l.trim())
                            .filter(Boolean);
                        setCreateData((prev) => ({ ...prev, labels: arr }));
                    }}
                    disabled={createLoading}
                    fullWidth
                />

                {/* Options */}
                <Box>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Options
                    </Typography>
                    <Stack direction="row" spacing={2} flexWrap="wrap">
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={createData.options.signAndProcess}
                                    onChange={(e) =>
                                        setCreateData((prev) => ({
                                            ...prev,
                                            options: {
                                                ...prev.options,
                                                signAndProcess: e.target.checked
                                            }
                                        }))
                                    }
                                />
                            }
                            label="Sign And Process"
                            disabled={createLoading}
                        />
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={createData.options.acceptDelayedBroadcast}
                                    onChange={(e) =>
                                        setCreateData((prev) => ({
                                            ...prev,
                                            options: {
                                                ...prev.options,
                                                acceptDelayedBroadcast: e.target.checked
                                            }
                                        }))
                                    }
                                />
                            }
                            label="Accept Delayed Broadcast"
                            disabled={createLoading}
                        />
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={createData.options.returnTXIDOnly}
                                    onChange={(e) =>
                                        setCreateData((prev) => ({
                                            ...prev,
                                            options: {
                                                ...prev.options,
                                                returnTXIDOnly: e.target.checked
                                            }
                                        }))
                                    }
                                />
                            }
                            label="Return TXID Only"
                            disabled={createLoading}
                        />
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={createData.options.noSend}
                                    onChange={(e) =>
                                        setCreateData((prev) => ({
                                            ...prev,
                                            options: {
                                                ...prev.options,
                                                noSend: e.target.checked
                                            }
                                        }))
                                    }
                                />
                            }
                            label="No Send"
                            disabled={createLoading}
                        />
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={createData.options.randomizeOutputs}
                                    onChange={(e) =>
                                        setCreateData((prev) => ({
                                            ...prev,
                                            options: {
                                                ...prev.options,
                                                randomizeOutputs: e.target.checked
                                            }
                                        }))
                                    }
                                />
                            }
                            label="Randomize Outputs"
                            disabled={createLoading}
                        />
                    </Stack>
                </Box>
            </Stack>

            <Divider sx={{ my: 2 }} />

            {/* Inputs */}
            <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
                mb={1}
            >
                <Typography variant="h6">Inputs</Typography>
                <Button
                    variant="contained"
                    startIcon={<AddCircleOutlineIcon />}
                    onClick={handleAddInputDialogOpen}
                    disabled={createLoading}
                >
                    Add Input
                </Button>
            </Box>

            {createData.inputs.map((inp, idx) => (
                <Paper
                    key={idx}
                    sx={{ p: 2, mb: 1, backgroundColor: '#f9f9f9', position: 'relative' }}
                    variant="outlined"
                >
                    <Box
                        display="flex"
                        justifyContent="flex-end"
                        alignItems="center"
                        sx={{ position: 'absolute', top: 4, right: 4 }}
                    >
                        <IconButton
                            size="small"
                            color="primary"
                            onClick={() => handleEditInputDialogOpen(idx)}
                            disabled={createLoading}
                        >
                            <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                            size="small"
                            color="warning"
                            onClick={() => removeInput(idx)}
                            disabled={createLoading}
                        >
                            <DeleteIcon fontSize="small" />
                        </IconButton>
                    </Box>
                    <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                label="Outpoint (txid.index)"
                                value={inp.outpoint}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                label="Input Description"
                                value={inp.inputDescription}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <TextField
                                label="Unlocking Script"
                                value={inp.unlockingScript || ''}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <TextField
                                label="Unlocking Script Length"
                                value={
                                    inp.unlockingScriptLength !== undefined
                                        ? String(inp.unlockingScriptLength)
                                        : ''
                                }
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <TextField
                                label="Sequence Number"
                                value={
                                    inp.sequenceNumber !== undefined
                                        ? String(inp.sequenceNumber)
                                        : ''
                                }
                                fullWidth
                                disabled
                            />
                        </Grid>
                    </Grid>
                </Paper>
            ))}

            <Divider sx={{ my: 2 }} />

            {/* Outputs */}
            <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
                mb={1}
            >
                <Typography variant="h6">Outputs</Typography>
                <Button
                    variant="contained"
                    startIcon={<AddCircleOutlineIcon />}
                    onClick={handleAddOutputDialogOpen}
                    disabled={createLoading}
                >
                    Add Output
                </Button>
            </Box>

            {createData.outputs.map((out, idx) => (
                <Paper
                    key={idx}
                    sx={{ p: 2, mb: 1, backgroundColor: '#f9f9f9', position: 'relative' }}
                    variant="outlined"
                >
                    <Box
                        display="flex"
                        justifyContent="flex-end"
                        alignItems="center"
                        sx={{ position: 'absolute', top: 4, right: 4 }}
                    >
                        <IconButton
                            size="small"
                            color="primary"
                            onClick={() => handleEditOutputDialogOpen(idx)}
                            disabled={createLoading}
                        >
                            <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                            size="small"
                            color="warning"
                            onClick={() => removeOutput(idx)}
                            disabled={createLoading}
                        >
                            <DeleteIcon fontSize="small" />
                        </IconButton>
                    </Box>
                    <Grid container spacing={2}>
                        <Grid item xs={12} sm={8}>
                            <TextField
                                label="Locking Script"
                                multiline
                                minRows={2}
                                value={out.lockingScript}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <TextField
                                label="Satoshis"
                                type="number"
                                value={out.satoshis}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="Output Description"
                                value={out.outputDescription}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                label="Basket (optional)"
                                value={out.basket || ''}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                label="Tags (if any)"
                                value={out.tags?.join(', ') || ''}
                                fullWidth
                                disabled
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="Custom Instructions"
                                multiline
                                minRows={2}
                                value={out.customInstructions || ''}
                                fullWidth
                                disabled
                            />
                        </Grid>
                    </Grid>
                </Paper>
            ))}

            {/* If both arrays are empty, show a small warning */}
            {bothArraysEmpty && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                    At least one input or one output is required.
                </Alert>
            )}

            {/**************************************************
       * Dialog: Add/Edit Input
       **************************************************/}
            <Dialog open={inputDialogOpen} onClose={handleCancelInputDialog} fullWidth maxWidth="sm">
                <DialogTitle>{editingInputIndex === null ? 'Add Input' : 'Edit Input'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Outpoint (txid.index)"
                            value={inputFormState.outpoint}
                            onChange={(e) =>
                                setInputFormState((prev) => ({ ...prev, outpoint: e.target.value }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Input Description"
                            value={inputFormState.inputDescription}
                            onChange={(e) =>
                                setInputFormState((prev) => ({
                                    ...prev,
                                    inputDescription: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Unlocking Script"
                            value={inputFormState.unlockingScript}
                            onChange={(e) =>
                                setInputFormState((prev) => ({
                                    ...prev,
                                    unlockingScript: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Unlocking Script Length"
                            type="number"
                            value={inputFormState.unlockingScriptLength}
                            onChange={(e) =>
                                setInputFormState((prev) => ({
                                    ...prev,
                                    unlockingScriptLength: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Sequence Number"
                            type="number"
                            value={inputFormState.sequenceNumber}
                            onChange={(e) =>
                                setInputFormState((prev) => ({
                                    ...prev,
                                    sequenceNumber: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleCancelInputDialog} disabled={createLoading}>
                        Cancel
                    </Button>
                    <Button onClick={handleSaveInput} variant="contained" disabled={createLoading}>
                        {editingInputIndex === null ? 'Add' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/**************************************************
       * Dialog: Add/Edit Output
       **************************************************/}
            <Dialog open={outputDialogOpen} onClose={handleCancelOutputDialog} fullWidth maxWidth="sm">
                <DialogTitle>{editingOutputIndex === null ? 'Add Output' : 'Edit Output'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="Locking Script"
                            multiline
                            minRows={2}
                            value={outputFormState.lockingScript}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    lockingScript: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Satoshis"
                            type="number"
                            value={outputFormState.satoshis}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    satoshis: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Output Description"
                            value={outputFormState.outputDescription}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    outputDescription: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Basket (optional)"
                            value={outputFormState.basket}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    basket: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Tags (comma-separated)"
                            value={outputFormState.tags}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    tags: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                        <TextField
                            label="Custom Instructions"
                            multiline
                            minRows={2}
                            value={outputFormState.customInstructions}
                            onChange={(e) =>
                                setOutputFormState((prev) => ({
                                    ...prev,
                                    customInstructions: e.target.value
                                }))
                            }
                            disabled={createLoading}
                            fullWidth
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleCancelOutputDialog} disabled={createLoading}>
                        Cancel
                    </Button>
                    <Button onClick={handleSaveOutput} variant="contained" disabled={createLoading}>
                        {editingOutputIndex === null ? 'Add' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default ActionsPage;
