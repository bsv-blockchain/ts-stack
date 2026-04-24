import { makeStyles } from '@mui/styles'
import { Theme } from '@mui/material/styles'

const useStyles = makeStyles((theme: Theme) => ({
  title: {
    paddingBottom: '0.5em'
  },
  sub_title: {
    paddingTop: '0.5em',
    paddingBottom: '0.5em'
  },
  back_button: {
    paddingTop: '2em',
    paddingBottom: '1em'
  },
  back_icon: {
    paddingRight: '0.5em'
  },
  send_icon: {
    paddingLeft: '0.3em'
  },
  table_title: {
    paddingTop: '2.5em',
    paddingLeft: '2.5em'
  }
}))

export default useStyles
