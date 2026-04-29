import { ViteReactSSG } from 'vite-react-ssg'
import { routes } from './routes'
import './styles/tokens.css'
import './styles/reset.css'
import './styles/code.css'
import './styles/callout.css'

export const createRoot = ViteReactSSG({ routes, basename: import.meta.env.BASE_URL })
