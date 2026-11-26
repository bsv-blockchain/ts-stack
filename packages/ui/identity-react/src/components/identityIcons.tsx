import { createSvgIcon } from '@mui/material'

export const SearchIcon = createSvgIcon(
  <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2">
    <circle cx="10" cy="10" r="5.5" />
    <path d="m14 14 5.5 5.5" />
  </g>,
  'Search'
)

export const ContentCopyIcon = createSvgIcon(
  <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2">
    <path d="M4 17V3h12" />
    <rect x="8" y="7" width="12" height="14" rx="1" />
  </g>,
  'ContentCopy'
)
