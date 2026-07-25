import { prerender } from 'react-dom/static'
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from 'react-router'
import { routes } from './routes'
import './styles/tokens.css'
import './styles/reset.css'
import './styles/code.css'
import './styles/callout.css'

export const basePath = import.meta.env.BASE_URL
export { docPaths as staticPaths } from './routes'

export async function render(pathname: string): Promise<string> {
  const handler = createStaticHandler(routes, { basename: basePath })
  const request = new Request(new URL(pathname, 'https://docs.bsvblockchain.org'))
  const context = await handler.query(request)

  if (context instanceof Response) {
    throw new TypeError(`Static route ${pathname} returned HTTP ${context.status}`)
  }

  const router = createStaticRouter(handler.dataRoutes, context)
  const { prelude } = await prerender(
    <StaticRouterProvider router={router} context={context} hydrate={false} />,
  )

  return new Response(prelude).text()
}
