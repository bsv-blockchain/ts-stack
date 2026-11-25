import React, { FC, useEffect } from 'react'
import { useStore } from './store'

/**
 * @property {string} src - The UHRP address of the media source to be resolved and used.
 * @property {React.ReactNode} [loading] - Optional content shown while the source URL is being resolved.
 * @property {React.SourceHTMLAttributes<HTMLSourceElement>} props - Additional HTML `<source>` attributes.
 */
interface SourceProps extends React.SourceHTMLAttributes<HTMLSourceElement> {
  src: string
  loading?: React.ReactNode
}

/**
 * A React component that provides a `<source>` element for `<video>` or `<audio>` tags,
 * using a UHRP address to resolve the media URL. Optionally displays a `loading` element
 * while the URL is being resolved.
 *
 * @param {SourceProps} props - The component's properties
 * @returns {JSX.Element} - The resolved `<source>` element or a loading indicator
 */
const Source: FC<SourceProps> = ({ src, loading, ...props }) => {
  const resolvedUrl = useStore(state => state.urls[src] || '')
  const setResolvedURL = useStore(state => state.setResolvedURL)

  useEffect(() => {
    setResolvedURL(src).catch(() => {})
  }, [src, setResolvedURL])

  if (resolvedUrl || !loading) {
    return <source src={resolvedUrl} {...props} />
  }
  return <>{loading}</>
}

export default Source
