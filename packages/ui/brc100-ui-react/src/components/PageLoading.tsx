import AppLogo from './AppLogo'

const PageLoading = () => (
  <div
    style={{
      height: '100vh',
      width: '100vw',
      display: 'grid',
      placeItems: 'center'
    }}
  >
    <AppLogo rotate size={128} />
  </div>
)

export default PageLoading
