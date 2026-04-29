import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { MDXProvider } from '@mdx-js/react'
import Header from '../components/Header'
import Sidebar from '../components/Sidebar'
import Footer from '../components/Footer'
import ToC from '../components/ToC'
import PageLayout from './PageLayout'
import { mdxComponents } from '../content/mdxComponents'
import '../styles/layout.css'
import '../styles/prose.css'
import '../styles/hero.css'

export default function RootLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { pathname } = useLocation()

  return (
    <MDXProvider components={mdxComponents}>
      <div className="site">
        <Header onMenuClick={() => setSidebarOpen(o => !o)} />
        <div className="site-body">
          <div className={'site-sidebar' + (sidebarOpen ? ' open' : '')}>
            <Sidebar />
          </div>
          {sidebarOpen && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 49,
                background: 'rgba(0,0,0,0.5)',
              }}
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <main className="site-content" id="main-content">
            <div className="site-content-main">
              <article className="prose">
                <PageLayout key={pathname}>
                  <Outlet />
                </PageLayout>
              </article>
            </div>
            <aside className="site-toc">
              <ToC key={pathname} />
            </aside>
          </main>
        </div>
        <Footer />
      </div>
    </MDXProvider>
  )
}
