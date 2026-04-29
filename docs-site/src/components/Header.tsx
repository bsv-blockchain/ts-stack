import { Link, useLocation } from 'react-router-dom'
import styles from './Header.module.css'
import SearchBox from './SearchBox'

const TOP_NAV = [
  { label: 'Get Started', href: '/get-started/' },
  { label: 'Architecture', href: '/architecture/' },
  { label: 'Packages', href: '/packages/' },
  { label: 'Specs', href: '/specs/' },
  { label: 'Guides', href: '/guides/' },
]

interface Props {
  onMenuClick?: () => void
}

export default function Header({ onMenuClick }: Props) {
  const { pathname } = useLocation()

  return (
    <header className="site-header">
      <div className={styles.inner}>
        <div className={styles.left}>
          <button
            className={styles.menuBtn}
            onClick={onMenuClick}
            aria-label="Toggle navigation"
          >
            <span className={styles.menuIcon} />
          </button>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoIcon}>{'<>'}</span>
            <span className={styles.logoText}>ts-stack</span>
          </Link>
        </div>

        <nav className={styles.topNav} aria-label="Main navigation">
          {TOP_NAV.map(({ label, href }) => (
            <Link
              key={href}
              to={href}
              className={
                styles.navLink +
                (pathname.startsWith(href) ? ' ' + styles.active : '')
              }
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className={styles.right}>
          <SearchBox />
          <Link
            to="/reference/"
            className={
              styles.navLink +
              (pathname.startsWith('/reference') ? ' ' + styles.active : '')
            }
          >
            Reference
          </Link>
          <a
            href="https://github.com/bsv-blockchain/ts-stack"
            className={styles.githubLink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  )
}
