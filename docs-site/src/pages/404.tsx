import { Link } from 'react-router-dom'
import styles from './404.module.css'

export default function NotFound() {
  return (
    <div className={styles.root}>
      <span className={styles.code}>404</span>
      <h1 className={styles.title}>Page not found</h1>
      <p className={styles.body}>
        This page doesn't exist. It may have moved or been removed.
      </p>
      <Link to="/" className={styles.link}>
        &larr; Back to home
      </Link>
    </div>
  )
}
