import { Avatar, Badge, Box, CardContent, Icon, IconButton, Snackbar, Tooltip, Typography } from '@mui/material';
import React, { useEffect, useState } from 'react';
import { DEFAULT_IDENTITY, IdentityProps } from '../types';
import { IdentityClient, DisplayableIdentity } from '@bsv/sdk';
import { Img } from '@bsv/uhrp-react';
import { ContentCopy as ContentCopyIcon } from '@mui/icons-material';

// Create an IdentityClient instance
const identityClient = new IdentityClient();

// SessionStorage-backed cache for resolved identities (persists across page reloads)
const CACHE_KEY = 'identity-card-cache';
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 100; // Prevent unbounded growth

class IdentityCache {
  private cache: Map<string, { identity: DisplayableIdentity; timestamp: number }>;

  constructor() {
    // Hydrate once from sessionStorage on init
    this.cache = new Map();
    try {
      const stored = sessionStorage.getItem(CACHE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        for (const [key, value] of Object.entries(parsed)) {
          this.cache.set(key, value as { identity: DisplayableIdentity; timestamp: number });
        }
      }
    } catch (e) {
      console.warn('Failed to load identity cache from sessionStorage:', e);
    }
  }

  private persist(): void {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(this.cache)));
    } catch (e) {
      console.warn('Failed to save identity cache to sessionStorage:', e);
    }
  }

  get(identityKey: string): DisplayableIdentity | null {
    const entry = this.cache.get(identityKey);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
      this.cache.delete(identityKey);
      this.persist();
      return null;
    }

    return entry.identity;
  }

  set(identityKey: string, identity: DisplayableIdentity): void {
    // Simple LRU: remove oldest entries if cache is full
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(identityKey, { identity, timestamp: Date.now() });
    this.persist();
  }
}

const identityCache = new IdentityCache();

const IdentityCard: React.FC<IdentityProps> = ({
  identityKey,
  themeMode = 'light'
}) => {
  const [resolvedIdentity, setResolvedIdentity] = useState<DisplayableIdentity>(DEFAULT_IDENTITY);
  const [copySnackbarOpen, setCopySnackbarOpen] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  const handleCopyIdentityKey = () => {
    if (identityKey) {
      navigator.clipboard.writeText(identityKey)
        .then(() => setCopySnackbarOpen(true))
        .catch(err => console.error('Could not copy identity key:', err))
    }
  };

  useEffect(() => {
    if (!identityKey) {
      setResolvedIdentity(DEFAULT_IDENTITY);
      return;
    }

    (async () => {
      try {
        // Check cache first
        const cached = identityCache.get(identityKey);
        if (cached) {
          setResolvedIdentity(cached);
          return;
        }

        // Fetch identities using the IdentityClient
        const matchingIdentities = await identityClient.resolveByIdentityKey({
          identityKey
        });

        // Select the first result (most relevant/trusted)
        if (matchingIdentities.length > 0) {
          const resolvedId = matchingIdentities[0];
          setResolvedIdentity(resolvedId);

          // Cache the result
          identityCache.set(identityKey, resolvedId);
        }
      } catch (error) {
        // Silently fall back to default identity on resolution failure
        setResolvedIdentity(DEFAULT_IDENTITY);
      }
    })();
  }, [identityKey]);

  return (
    <React.Fragment>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          borderRadius: '16px',
          padding: '0.2em 0.4em 0.2em 0.5em',
          maxWidth: 345,
          border: 'none',
          backgroundColor: 'transparent'
        }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <Tooltip
          title={
            resolvedIdentity.badgeLabel
          }
          placement="right"
        >
          <Badge
            overlap="circular"
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            badgeContent={
              <Icon
                style={{
                  width: '20px',
                  height: '20px',
                  backgroundColor: 'white',
                  borderRadius: '20%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Img
                  style={{ width: '95%', height: '95%', objectFit: 'cover', borderRadius: '20%' }}
                  src={resolvedIdentity.badgeIconURL}
                  loading={undefined}
                />
              </Icon>
            }
          >
            <Avatar alt={resolvedIdentity.name} sx={{ width: '2.5em', height: '2.5em' }}>
              <Img
                style={{ width: '100%', height: 'auto' }}
                src={resolvedIdentity.avatarURL}
                loading={undefined}
              />
            </Avatar>
          </Badge>
        </Tooltip>
        <CardContent
          sx={{
            flex: '1 0 auto',
            padding: '8px !important',
            '&:last-child': { paddingBottom: '8px !important' }
          }}
        >
          <Typography
            variant="h6"
            component="div"
            fontSize="1em"
            color={themeMode === 'light' ? 'black' : 'white'}
          >
            {resolvedIdentity.name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="body2" color={themeMode === 'light' ? 'lightGray' : 'darkGray'}>
              {identityKey ? identityKey.slice(0, 10) + '...' : <></>}
            </Typography>
            {identityKey && (
              <Tooltip title="Copy identity key">
                <IconButton
                  size="small"
                  sx={{
                    ml: 1,
                    p: 0.5,
                    opacity: isHovering ? 1 : 0,
                    visibility: isHovering ? 'visible' : 'hidden',
                    transition: 'opacity 0.2s ease-in-out',
                    // Reserve space even when button is hidden
                    width: '24px',
                    height: '24px',
                  }}
                  onClick={handleCopyIdentityKey}
                >
                  <ContentCopyIcon fontSize="small" sx={{ color: themeMode === 'light' ? 'lightGray' : 'darkGray', fontSize: '0.9rem' }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </CardContent>
      </Box>
      <Snackbar
        open={copySnackbarOpen}
        autoHideDuration={3000}
        onClose={() => setCopySnackbarOpen(false)}
        message="Identity key copied to clipboard"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </React.Fragment>
  );
};

export default IdentityCard;
