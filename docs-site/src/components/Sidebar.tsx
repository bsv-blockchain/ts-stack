import { NavLink, useLocation } from 'react-router-dom'
import { NAV, type NavItem } from '../lib/nav'
import '../styles/sidebar.css'

interface Props {
  className?: string
}

export default function Sidebar({ className }: Readonly<Props>) {
  const { pathname } = useLocation()

  return (
    <nav className={'sidebar' + (className ? ' ' + className : '')} aria-label="Site navigation">
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          'sidebar-link' + (isActive ? ' active' : '')
        }
      >
        Home
      </NavLink>

      {NAV.map(section => (
        <div key={section.label} className="sidebar-section">
          <span className="sidebar-section-label">{section.label}</span>
          {section.items.map(item => (
            <SidebarItem key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
      ))}
    </nav>
  )
}

function SidebarItem({ item, pathname }: { item: NavItem; pathname: string }) {
  const hasChildren = item.items && item.items.length > 0
  const isParentActive =
    hasChildren && pathname.startsWith(item.href.replace(/\/$/, ''))

  return (
    <>
      <NavLink
        to={item.href}
        end={!hasChildren}
        className={({ isActive }) =>
          'sidebar-link' + (isActive || isParentActive ? ' active' : '')
        }
      >
        {item.label}
      </NavLink>
      {hasChildren && isParentActive && (
        <div className="sidebar-sub">
          {item.items!.map(child => (
            <NavLink
              key={child.href}
              to={child.href}
              end
              className={({ isActive }) =>
                'sidebar-link' + (isActive ? ' active' : '')
              }
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </>
  )
}
