import styles from './AsyncApiEmbed.module.css'

interface Props {
  slug: 'brc29' | 'brc31' | 'authsocket' | 'gasp'
  title?: string
  height?: number
}

export default function AsyncApiEmbed({ slug, title, height = 900 }: Props) {
  const labels: Record<string, string> = {
    brc29: 'BRC-29 Peer Payment',
    brc31: 'BRC-31 Auth Handshake',
    authsocket: 'Authsocket (WebSocket)',
    gasp: 'GASP Sync',
  }

  return (
    <div className={styles.wrapper}>
      <iframe
        src={`/assets/asyncapi/${slug}/index.html`}
        title={title ?? labels[slug] ?? slug}
        style={{ minHeight: height }}
        className={styles.frame}
        loading="lazy"
      />
    </div>
  )
}
