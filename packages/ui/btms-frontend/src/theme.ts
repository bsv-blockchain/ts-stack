import { createTheme } from '@mui/material/styles'

const web3Theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#0f766e',
      dark: '#0b4f4a'
    },
    secondary: {
      main: '#f97316'
    },
    error: {
      main: '#dc2626'
    },
    background: {
      default: '#f6f3ee',
      paper: '#ffffff'
    },
    text: {
      primary: '#0f172a',
      secondary: '#475569'
    },
    divider: '#e2e8f0'
  },
  typography: {
    fontFamily: '"Space Grotesk", "Manrope", sans-serif',
    h2: {
      fontWeight: 700,
      letterSpacing: '-0.02em'
    },
    h3: {
      fontWeight: 700,
      letterSpacing: '-0.02em'
    },
    h4: {
      fontWeight: 650,
      letterSpacing: '-0.015em'
    },
    h5: {
      fontWeight: 650
    },
    h6: {
      fontWeight: 600
    },
    button: {
      textTransform: 'none',
      fontWeight: 600
    }
  },
  shape: {
    borderRadius: 18
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          background: 'radial-gradient(circle at top, #ffffff 0%, #f6f3ee 55%, #efe9e0 100%)',
          color: '#0f172a'
        },
        a: {
          color: '#0f766e',
          textDecoration: 'none'
        },
        '::selection': {
          backgroundColor: '#fde68a'
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 20,
          border: '1px solid rgba(15, 23, 42, 0.08)'
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 20,
          paddingBlock: 10,
          whiteSpace: 'nowrap'
        }
      }
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          textTransform: 'uppercase',
          fontSize: '0.72rem',
          letterSpacing: '0.08em',
          color: '#475569'
        },
        body: {
          fontSize: '0.95rem'
        }
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 24
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          backgroundColor: '#ffffff'
        }
      }
    }
  }
})

export default web3Theme
