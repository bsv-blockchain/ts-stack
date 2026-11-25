import React, { FC, useEffect } from 'react'
import { useStore } from './store'

/**
 * @property {string} src - The UHRP address of the image to be resolved and displayed.
 * @property {React.ReactNode} [fallback] - Optional fallback content shown if the image URL cannot be resolved.
 * @property {Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>} props - Additional HTML image attributes.
 */
type ImgProps = {
  src: string
  fallback?: React.ReactNode
} & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>

/**
 * A React component that displays an image from a UHRP URL. The URL is resolved
 * using the provided store logic and displayed once available. Optionally, a
 * fallback element can be shown if the URL cannot be resolved.
 *
 * @param {ImgProps} props - The component's properties
 * @returns {JSX.Element} - The resolved image element or fallback content
 */

const Img: FC<ImgProps> = ({ src, fallback, ...props }) => {
  const resolvedUrl = useStore(state => state.urls[src] || '')
  const setResolvedURL = useStore(state => state.setResolvedURL)

  useEffect(() => {
    setResolvedURL(src).catch(() => {})
  }, [src, setResolvedURL])

  return resolvedUrl
    ? <img src={resolvedUrl} {...props} />
    : <>{fallback || null}</>
}

export default Img
