import { useEffect, useState } from 'react';
import {
    Box,
    Typography,
    Paper,
    Stack,
    TextField,
    Button,
    List,
    ListItem,
    ListItemText,
    Pagination,
    Alert,
    FormControl,
    Select,
    MenuItem,
    InputLabel,
    Checkbox,
    FormControlLabel,
    Collapse
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import { useWallet } from '../contexts/WalletContext';

interface OutputItem {
    outpoint: string;
    satoshis: number;
    lockingScript?: string;
    spendable: boolean;
    customInstructions?: string;
    tags?: string[];
    labels?: string[];
    entireTransaction?: number[]; // If "include entire transactions" is requested
}

function OutputsPage() {
    const { wallet } = useWallet();

    /******************************************************
     * Filters & Pagination
     ******************************************************/
    const [basket, setBasket] = useState<string>('default');
    const [tags, setTags] = useState<string>('');
    const [tagQueryMode, setTagQueryMode] = useState<'any' | 'all'>('any');

    const [includeCustomInstructions, setIncludeCustomInstructions] = useState(true);
    const [includeTags, setIncludeTags] = useState(true);
    const [includeLabels, setIncludeLabels] = useState(false);
    const [includeOption, setIncludeOption] = useState<'locking scripts' | 'entire transactions' | ''>(
        ''
    );
    const [limit, setLimit] = useState(5);
    const [page, setPage] = useState(1);

    const [outputs, setOutputs] = useState<OutputItem[]>([]);
    const [totalOutputs, setTotalOutputs] = useState(0);
    const [loadingList, setLoadingList] = useState(false);
    const [listError, setListError] = useState<string>('');

    /******************************************************
     * useEffect - initial fetch
     ******************************************************/
    useEffect(() => {
        if (wallet) {
            fetchOutputs(1);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wallet]);

    /******************************************************
     * fetchOutputs
     ******************************************************/
    async function fetchOutputs(currentPage: number) {
        if (!wallet) return;
        setLoadingList(true);
        setListError('');
        try {
            const tagArr = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

            // The "include" param from BRC-100 can be:
            //   '' (none),
            //   'locking scripts',
            //   'entire transactions'
            // We'll interpret our `includeOption` state to pass the correct param.
            let includeVal: 'locking scripts' | 'entire transactions' | undefined = undefined;
            if (includeOption === 'locking scripts') {
                includeVal = 'locking scripts';
            } else if (includeOption === 'entire transactions') {
                includeVal = 'entire transactions';
            }

            const resp = await wallet.listOutputs({
                basket,
                tags: tagArr.length > 0 ? tagArr : undefined,
                tagQueryMode,
                include: includeVal,
                includeCustomInstructions,
                includeTags,
                includeLabels,
                limit,
                offset: (currentPage - 1) * limit
            });

            setOutputs(resp.outputs || []);
            setTotalOutputs(resp.totalOutputs || 0);
        } catch (err: any) {
            console.error('listOutputs error:', err);
            setListError(err?.message || String(err));
        } finally {
            setLoadingList(false);
        }
    }

    /******************************************************
     * handleRelinquish
     ******************************************************/
    async function handleRelinquish(outpoint: string) {
        if (!wallet) return;
        try {
            await wallet.relinquishOutput({
                basket,
                output: outpoint
            });
            // re-fetch
            fetchOutputs(page);
        } catch (err) {
            console.error(err);
        }
    }

    /******************************************************
     * Render
     ******************************************************/
    return (
        <Box>
            <Typography variant="h4" gutterBottom>
                Outputs
            </Typography>

            {/* FILTERS Panel */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Typography variant="subtitle1">Filters</Typography>
                <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap">
                    <TextField
                        label="Basket"
                        size="small"
                        value={basket}
                        onChange={(e) => setBasket(e.target.value)}
                    />
                    <TextField
                        label="Tags (comma-separated)"
                        size="small"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                    />
                    <FormControl size="small" sx={{ width: 140 }}>
                        <InputLabel>Tag Query Mode</InputLabel>
                        <Select
                            label="Tag Query Mode"
                            value={tagQueryMode}
                            onChange={(e) => setTagQueryMode(e.target.value as 'any' | 'all')}
                        >
                            <MenuItem value="any">any</MenuItem>
                            <MenuItem value="all">all</MenuItem>
                        </Select>
                    </FormControl>

                    <FormControl size="small" sx={{ width: 200 }}>
                        <InputLabel>Include</InputLabel>
                        <Select
                            label="Include"
                            value={includeOption}
                            onChange={(e) =>
                                setIncludeOption(e.target.value as
                                    | 'locking scripts'
                                    | 'entire transactions'
                                    | '')
                            }
                        >
                            <MenuItem value="">None</MenuItem>
                            <MenuItem value="locking scripts">Locking Scripts</MenuItem>
                            <MenuItem value="entire transactions">Entire Txn (BEEF)</MenuItem>
                        </Select>
                    </FormControl>
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={includeCustomInstructions}
                                onChange={(e) => setIncludeCustomInstructions(e.target.checked)}
                            />
                        }
                        label="Include Custom Instructions"
                    />
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={includeTags}
                                onChange={(e) => setIncludeTags(e.target.checked)}
                            />
                        }
                        label="Include Tags"
                    />
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={includeLabels}
                                onChange={(e) => setIncludeLabels(e.target.checked)}
                            />
                        }
                        label="Include Labels"
                    />
                </Stack>

                <Box
                    sx={{ mt: 2 }}
                    display="flex"
                    alignItems="center"
                    justifyContent="space-between"
                    flexWrap="wrap"
                >
                    <Button
                        variant="outlined"
                        onClick={() => {
                            setPage(1);
                            fetchOutputs(1);
                        }}
                    >
                        Apply Filters
                    </Button>
                    <FormControl size="small" sx={{ width: 100 }}>
                        <InputLabel>Limit</InputLabel>
                        <Select
                            label="Limit"
                            value={limit}
                            onChange={(e) => {
                                setLimit(Number(e.target.value));
                                setPage(1);
                                fetchOutputs(1);
                            }}
                        >
                            <MenuItem value={5}>5</MenuItem>
                            <MenuItem value={10}>10</MenuItem>
                            <MenuItem value={25}>25</MenuItem>
                        </Select>
                    </FormControl>
                </Box>
            </Paper>

            {/* LIST of outputs */}
            <Paper sx={{ p: 2 }}>
                {loadingList && <Typography>Loading...</Typography>}
                {listError && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                        {listError}
                    </Alert>
                )}
                {!loadingList && !listError && outputs.length === 0 && (
                    <Typography>No outputs found.</Typography>
                )}

                <List>
                    {outputs.map((o, i) => (
                        <OutputListItem
                            key={i}
                            item={o}
                            relinquish={() => handleRelinquish(o.outpoint)}
                        />
                    ))}
                </List>

                {outputs.length > 0 && (
                    <Pagination
                        sx={{ mt: 2 }}
                        page={page}
                        count={Math.ceil(totalOutputs / limit)}
                        onChange={(_, val) => {
                            setPage(val);
                            fetchOutputs(val);
                        }}
                    />
                )}
            </Paper>
        </Box>
    );
}

/******************************************************
 * A subcomponent to show each output in a neat manner.
 * We also expand/collapse if "entireTransaction" was included.
 ******************************************************/
function OutputListItem({
    item,
    relinquish
}: {
    item: OutputItem;
    relinquish: () => void;
}) {
    const [expanded, setExpanded] = useState(false);

    function toggleExpand() {
        setExpanded((prev) => !prev);
    }

    return (
        <ListItem
            sx={{
                borderBottom: '1px solid #eee',
                display: 'block'
            }}
        >
            <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
                sx={{ mb: 1 }}
            >
                <ListItemText
                    primary={`Outpoint: ${item.outpoint}`}
                    secondary={
                        <>
                            Satoshis: {item.satoshis}
                            {item.lockingScript ? (
                                <>
                                    <br />
                                    LockingScript: {item.lockingScript.slice(0, 40)}
                                    {item.lockingScript.length > 40 ? '...' : ''}
                                </>
                            ) : null}
                            {item.tags?.length ? (
                                <>
                                    <br />
                                    Tags: {item.tags.join(', ')}
                                </>
                            ) : null}
                            {item.customInstructions ? (
                                <>
                                    <br />
                                    Custom: {item.customInstructions}
                                </>
                            ) : null}
                            {item.labels?.length ? (
                                <>
                                    <br />
                                    Labels: {item.labels.join(', ')}
                                </>
                            ) : null}
                        </>
                    }
                />
                <Button variant="contained" color="warning" onClick={relinquish}>
                    Relinquish
                </Button>
            </Box>

            {/* If entireTransaction is present, let's show a toggle to expand/collapse */}
            {item.entireTransaction && item.entireTransaction.length > 0 && (
                <Box sx={{ mb: 1 }}>
                    <Button
                        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                        onClick={toggleExpand}
                        size="small"
                    >
                        {expanded ? 'Hide Entire Tx' : 'Show Entire Tx'}
                    </Button>
                    <Collapse in={expanded} unmountOnExit>
                        <Paper variant="outlined" sx={{ p: 1, mt: 1, maxHeight: 300, overflow: 'auto' }}>
                            <Typography variant="body2">
                                {bytesToHex(item.entireTransaction)}
                            </Typography>
                        </Paper>
                    </Collapse>
                </Box>
            )}
        </ListItem>
    );
}

/** Convert numeric array to hex string. */
function bytesToHex(arr: number[]): string {
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default OutputsPage;
