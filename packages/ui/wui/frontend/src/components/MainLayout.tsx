import { useState, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import {
    AppBar,
    Toolbar,
    Typography,
    IconButton,
    Drawer,
    List,
    ListItemButton,
    ListItemText,
    Box,
    Select,
    MenuItem,
    FormControl,
    InputLabel,
    useMediaQuery,
    Divider,
    ListItemIcon
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import StorageIcon from '@mui/icons-material/Storage';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import LockIcon from '@mui/icons-material/Lock';
import DescriptionIcon from '@mui/icons-material/Description';
import SettingsIcon from '@mui/icons-material/Settings';

import { useTheme } from '@mui/material/styles';
import { useWallet } from '../contexts/WalletContext';
import { getAllConfigs, WalletConfig } from '../utils/configStorage';
import { parseDomain } from '../utils/miscHelpers';

const drawerWidth = 320;

function MainLayout() {
    const navigate = useNavigate();
    const theme = useTheme();
    const isLargeScreen = useMediaQuery(theme.breakpoints.up('md'));

    const [mobileOpen, setMobileOpen] = useState(false);
    const { pickActiveConfig } = useWallet();

    // We'll load all configs so that the user can switch from the top drop-down
    const [configs, setConfigs] = useState<WalletConfig[]>([]);
    const [selectedId, setSelectedId] = useState<string>('');

    useEffect(() => {
        const c = getAllConfigs();
        setConfigs(c);
    }, []);

    // If user changes the active config outside of this component, we might want to re-check.
    // For simplicity, we do not. You could re-check on an interval or use a separate context event.

    const handleDrawerToggle = () => {
        setMobileOpen(!mobileOpen);
    };
    // Build the label for the currently active config
    let subLabel = '';
    if (selectedId) {
        const c = configs.find((cfg) => cfg.id === selectedId);
        if (c) {
            const domain = parseDomain(c.storage);
            subLabel = `${c.network.toUpperCase()} | ${domain}`;
        }
    }

    // On mount, we might detect the active config from localStorage
    useEffect(() => {
        // Possibly read the active config from localStorage if it is set
        // But we can also read from the wallet context, which doesn't directly store the config ID.
        // We'll just do a best-effort approach. If the wallet is set, we can't easily figure out the ID
        // unless we store it in a hidden place. Let's skip real synchronization for brevity.
        // We'll set selectedId to the stored active config if we had it:
        const activeId = localStorage.getItem('brc100ActiveConfig') || '';
        setSelectedId(activeId);
    }, []);

    async function handleSelectConfig(newId: string) {
        if (newId === 'manage') {
            // user clicked "Manage configs"
            await pickActiveConfig(null);
            setSelectedId('');
            navigate('/');
            return;
        }
        setSelectedId(newId);
        // load it
        await pickActiveConfig(newId);
        // close the drawer if we’re on mobile
        if (!isLargeScreen) {
            setMobileOpen(false);
        }
    }

    const navItems = [
        {
            label: 'Actions',
            icon: <CompareArrowsIcon />,
            subtitle: 'Transaction creation & signing',
            path: '/actions'
        },
        {
            label: 'Outputs',
            icon: <StorageIcon />,
            subtitle: 'UTXOs & baskets',
            path: '/outputs'
        },
        {
            label: 'Keys & Linkage',
            icon: <CallSplitIcon />,
            subtitle: 'Public keys & revelation',
            path: '/keys'
        },
        {
            label: 'Cryptography & Signatures',
            icon: <LockIcon />,
            subtitle: 'Encrypt, decrypt, sign, HMAC',
            path: '/crypto'
        },
        {
            label: 'Identity Resolution',
            icon: <DescriptionIcon />,
            subtitle: 'Search by public key or attributes',
            path: '/identity-resolution'
        },
        {
            label: 'Certificates',
            icon: <DescriptionIcon />,
            subtitle: 'Issuance & proving identity docs',
            path: '/certificates'
        },
        {
            label: 'Import & Export Funds',
            icon: <SettingsIcon />,
            subtitle: 'Move sats in and out of this wallet',
            path: '/import-export'
        },
        {
            label: 'Utilities',
            icon: <SettingsIcon />,
            subtitle: 'Height, network, version, etc.',
            path: '/utilities'
        },
        {
            label: 'Data',
            icon: <SettingsIcon />,
            subtitle: 'Data management & storage',
            path: '/data'
        }
    ];

    const drawerContent = (
        <Box
            sx={{
                width: isLargeScreen ? 320 : 320,
                display: 'flex',
                flexDirection: 'column',
                height: '100%'
            }}
        >
            {/* Config selection at the top */}
            <Box sx={{ p: 4, pt: 6 }}>
                <Typography align='center' variant='h1'>WUI</Typography>
                <Typography align='center' variant='subtitle1' color='textSecondary' sx={{ mb: 4 }}>Wallet User Interface</Typography>
                <FormControl fullWidth variant="outlined" size="small">
                    <InputLabel>Active Config</InputLabel>
                    <Select
                        label="Active Config"
                        value={selectedId || ''}
                        onChange={(e) => handleSelectConfig(e.target.value)}
                    >
                        {configs.map((c) => (
                            <MenuItem key={c.id} value={c.id}>
                                {c.name} (••••{c.pubKeySuffix})
                            </MenuItem>
                        ))}
                        <MenuItem value="manage">Manage Configs...</MenuItem>
                    </Select>
                </FormControl>
                {selectedId && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {subLabel}
                    </Typography>
                )}
            </Box>
            <Divider />

            {/* Nav links */}
            <List>
                {navItems.map((item) => (
                    <ListItemButton
                        key={item.path}
                        onClick={() => {
                            navigate(item.path);
                            if (!isLargeScreen) setMobileOpen(false);
                        }}
                    >
                        <ListItemIcon>{item.icon}</ListItemIcon>
                        <ListItemText
                            primary={item.label}
                            secondary={item.subtitle}
                        />
                    </ListItemButton>
                ))}
            </List>
            <Box sx={{ flex: 1 }} />

            {/* Footer with version/link info */}
            <Box sx={{ p: 2, borderTop: '1px solid #ddd' }}>
                <Typography variant="body2" align="center">
                    v1.0.0 – &copy; 2025 &nbsp;
                    <a
                        href="https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        BRC-100 Spec
                    </a>
                </Typography>
            </Box>
        </Box>
    );

    return (
        <Box sx={{ display: 'flex' }}>
            {/* If large screen, permanent drawer; otherwise temporary. */}
            {isLargeScreen ? (
                <Drawer
                    variant="permanent"
                    sx={{
                        width: drawerWidth,
                        flexShrink: 0,
                        '& .MuiDrawer-paper': {
                            width: drawerWidth,
                            boxSizing: 'border-box'
                        }
                    }}
                    open
                >
                    {drawerContent}
                </Drawer>
            ) : (
                <>
                    <AppBar position="fixed">
                        <Toolbar>
                            <IconButton
                                edge="start"
                                color="inherit"
                                aria-label="menu"
                                onClick={handleDrawerToggle}
                            >
                                <MenuIcon />
                            </IconButton>
                            <Typography variant="h6" noWrap component="div">
                                BRC-100 Wallet UI
                            </Typography>
                        </Toolbar>
                    </AppBar>

                    <Drawer
                        variant="temporary"
                        open={mobileOpen}
                        onClose={handleDrawerToggle}
                        ModalProps={{ keepMounted: true }}
                    >
                        {drawerContent}
                    </Drawer>
                </>
            )}

            {/* The main content area – offset if permanent drawer */}
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    margin: 'auto',
                    maxWidth: '1560px',
                    // ml: { md: `${drawerWidth}px` },
                    width: { md: `calc(100% - ${drawerWidth}px)` },
                    p: 2
                }}
            >
                <Outlet />
            </Box>
        </Box>
    );
}

export default MainLayout;
