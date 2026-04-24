import { makeStyles } from '@mui/styles'
import { Theme } from '@mui/material/styles'

const useStyles = makeStyles((theme: Theme) => ({
  title: {
    paddingTop: '3.5em',
    paddingBottom: '2.5em'
  },
  sub_title: {
    paddingTop: '0.5em'
  },
  table_title: {
    paddingTop: '2.5em',
    paddingBottom: '1em'
  },
  no_tokens: {
    paddingTop: '1.5em',
    paddingBottom: '1.5em'
  },
  link: {
    textDecoration: 'none',
    transition: 'background-color 0.2s ease',
    '&:hover': {
      backgroundColor: 'rgba(15, 23, 42, 0.04)'
    }
  },
  send_icon: {
    paddingLeft: '0.3em'
  }
}))

export default useStyles
