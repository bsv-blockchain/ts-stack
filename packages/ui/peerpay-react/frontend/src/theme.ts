import { createTheme } from '@mui/material/styles'

const web3Theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#5fe2c4',
      dark: '#2ec2a2',
      light: '#96f1dc',
      contrastText: '#04110f'
    },
    secondary: {
      main: '#8fb4ff',
      dark: '#6d92dd',
      light: '#bfd3ff'
    },
    background: {
      default: '#040913',
      paper: '#121c2a'
    },
    text: {
      primary: '#eef5ff',
      secondary: '#94a6be'
    },
    divider: 'rgba(151, 186, 222, 0.2)',
    error: {
      main: '#ff5f70'
    }
  },
  shape: {
    borderRadius: 16
  },
  typography: {
    fontFamily: '"Sora", "Avenir Next", "Segoe UI", sans-serif',
    h4: {
      fontWeight: 700,
      letterSpacing: '-0.02em'
    },
    h5: {
      fontWeight: 700,
      letterSpacing: '-0.01em'
    },
    h6: {
      fontWeight: 650
    },
    body1: {
      lineHeight: 1.5
    },
    button: {
      textTransform: 'none',
      fontWeight: 600,
      letterSpacing: '0.01em'
    }
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 14
        },
        contained: {
          boxShadow: 'none',
          '&:hover': {
            boxShadow: 'none'
          }
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none'
        }
      }
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        InputLabelProps: {
          shrink: true
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 14,
          backgroundColor: 'rgba(7, 16, 28, 0.65)',
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(158, 197, 240, 0.28)'
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(158, 197, 240, 0.46)'
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: '#5fe2c4'
          }
        }
      }
    }
  }
})

export default web3Theme
