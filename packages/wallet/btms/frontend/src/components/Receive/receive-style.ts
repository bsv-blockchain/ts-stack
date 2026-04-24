import { makeStyles } from '@mui/styles'
import { Theme } from '@mui/material/styles'

const useStyles = makeStyles((theme: Theme) => ({
  no_tokens: {
    paddingTop: '1.5em',
    paddingBottom: '1.5em'
  },
  row_container: {
    display: 'grid !important',
    paddingTop: '0.25em !important',
    paddingBottom: '1em',
    gridTemplateColumns: 'auto 1fr',
    gridColumnGap: '1.5em'
  }
}))

export default useStyles
