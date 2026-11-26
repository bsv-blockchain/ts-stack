import Grid from '@mui/material/Grid'
import CertificateCard from './CertificateCard'

const CertificatesGrid = ({ certificates }) => {
  return (
    <Grid container spacing={2}>
      {certificates.map(cert => (
        <Grid
          item
          sx={{ xs: 12, sm: 6, md: 4 }}
          key={`${cert.certifier}:${cert.type}:${cert.serialNumber}`}
        >
          <CertificateCard certificate={cert} />
        </Grid>
      ))}
    </Grid>
  )
}
export default CertificatesGrid
