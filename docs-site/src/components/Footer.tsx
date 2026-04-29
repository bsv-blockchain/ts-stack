import { Link } from 'react-router-dom'
import styles from './Footer.module.css'

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className={styles.inner}>
        <span>
          &copy; {new Date().getFullYear()} BSV Blockchain.{' '}
          <a href="https://github.com/bsv-blockchain/ts-stack">ts-stack</a> is open-source.
        </span>
        <nav className={styles.links} aria-label="Footer navigation">
          <a href="https://github.com/bsv-blockchain/ts-stack">GitHub</a>
          <Link to="/about/contributing/">Contributing</Link>
          <Link to="/about/versioning/">Versioning</Link>
        </nav>
      </div>
    </footer>
  )
}
