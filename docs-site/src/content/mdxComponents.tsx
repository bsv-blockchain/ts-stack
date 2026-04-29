import type { ComponentPropsWithoutRef } from 'react'
import CodeBlock from '../components/CodeBlock'
import Callout from '../components/Callout'
import AsyncApiEmbed from '../components/AsyncApiEmbed'

type AnchorProps = ComponentPropsWithoutRef<'a'>
type ImgProps = ComponentPropsWithoutRef<'img'>
type PreProps = ComponentPropsWithoutRef<'pre'>
type CodeProps = ComponentPropsWithoutRef<'code'>

function Anchor({ href, children, ...rest }: AnchorProps) {
  const isExternal = href?.startsWith('http')
  return (
    <a
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      {...rest}
    >
      {children}
    </a>
  )
}

function Img({ src, alt, ...rest }: ImgProps) {
  return <img src={src} alt={alt ?? ''} loading="lazy" {...rest} />
}

function Pre({ children, ...rest }: PreProps) {
  return <CodeBlock {...rest}>{children}</CodeBlock>
}

function InlineCode({ children, ...rest }: CodeProps) {
  return <code {...rest}>{children}</code>
}

export const mdxComponents = {
  a: Anchor,
  img: Img,
  pre: Pre,
  code: InlineCode,
  Callout,
  AsyncApiEmbed,
}
