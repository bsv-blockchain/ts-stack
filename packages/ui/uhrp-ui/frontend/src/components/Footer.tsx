import React from 'react'
import { Typography } from '@mui/material'

const Footer: React.FC = () => {
  return (
    <>
      <br />
      <br />
      <Typography align='center' paragraph>
        Check out the <a href='https://github.com/bsv-blockchain/uhrp-services'>Universal Hash Resolution Protocol</a>!
      </Typography>
      <Typography align='center'>
        <a href='https://github.com/bsv-blockchain/uhrp-ui'>BSV UHRP UI</a>
      </Typography>
    </>
  )
}

export default Footer
