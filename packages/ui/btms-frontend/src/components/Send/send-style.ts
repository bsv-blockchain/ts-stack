import { makeStyles } from '@mui/styles'
import { Theme } from '@mui/material/styles'

const useStyles = makeStyles((theme: Theme) => ({
  sub_title: {
    paddingTop: '0.5em'
  },
  button: {
    marginBottom: '0.9em',
    marginRight: '0.9em'
  },
  form: {
    marginTop: '0.25em !important'
  }
}))

export default useStyles
