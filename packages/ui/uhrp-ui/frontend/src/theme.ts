import { createTheme } from '@mui/material/styles'

// Define a custom theme with a dark background

// Define custom spacing function compatible with Spacing type
const customSpacing = (factor: number): string => `${8 * factor}px`

// Create custom theme using createTheme
const web3Theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#00d1b2'
    },
    secondary: {
      main: '#7e57c2'
    },
    background: {
      default: '#121212',
      paper: '#242424'
    },
    error: {
      main: '#ff3860'
    }
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h4: {
      fontWeight: 700
    },
    button: {
      textTransform: 'none'
    }
  },
  // Override default MUI spacing with custom spacing function
  spacing: customSpacing
})

export default web3Theme // Export custom theme
