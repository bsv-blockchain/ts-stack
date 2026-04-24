import { makeStyles } from '@mui/styles'
import { Theme } from '@mui/material/styles'

const useStyles = makeStyles((theme: Theme) => ({
  title: {
    paddingTop: '2.5em'
  },
  sub_title: {
    paddingTop: '1.5em'
  },
  form: {
    paddingTop: '2em',
    rowGap: '1em'
  },
  button: {
    paddingTop: '1.5em',
    paddingBottom: '1.5em'
  },
  back_icon: {
    paddingRight: '0.5em'
  },
  photo_preview_img: {
    maxWidth: '16em',
    maxHeight: '16em',
    borderRadius: '1.5em',
    objectFit: 'cover'
  },
  photo_container: {
    width: '16em',
    height: '16em',
    borderRadius: '1.5em !important',
    display: 'grid',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px dashed rgba(15, 23, 42, 0.2)',
    background: 'rgba(255, 255, 255, 0.7)'
  },
  photo_preview: {
    position: 'relative'
  }
}))

export default useStyles
