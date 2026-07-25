import { createRoot, hydrateRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './routes'
import './styles/tokens.css'
import './styles/reset.css'
import './styles/code.css'
import './styles/callout.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root application container')

const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })
const app = <RouterProvider router={router} />

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
const routePath = window.location.pathname.startsWith(basePath)
  ? window.location.pathname.slice(basePath.length) || '/'
  : window.location.pathname
const renderedRoute = container.dataset.route
const canHydrate = container.hasChildNodes()
  && (renderedRoute === '*' || renderedRoute === routePath)

if (canHydrate) {
  hydrateRoot(container, app)
} else {
  container.replaceChildren()
  createRoot(container).render(app)
}
