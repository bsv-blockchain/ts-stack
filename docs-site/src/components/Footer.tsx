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
          <a href="/about/contributing/">Contributing</a>
          <a href="/about/versioning/">Versioning</a>
        </nav>
      </div>
    </footer>
  )
}
