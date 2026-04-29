import type { ReactNode } from 'react'
import '../styles/callout.css'

type Kind = 'note' | 'info' | 'tip' | 'success' | 'warning' | 'danger' | 'error' | 'example'

const LABELS: Record<Kind, string> = {
  note: 'Note',
  info: 'Info',
  tip: 'Tip',
  success: 'Success',
  warning: 'Warning',
  danger: 'Danger',
  error: 'Error',
  example: 'Example',
}

interface Props {
  kind?: Kind
  title?: string
  children: ReactNode
}

export default function Callout({ kind = 'note', title, children }: Props) {
  return (
    <div className={'callout ' + kind}>
      <div className="callout-title">{title ?? LABELS[kind]}</div>
      <div className="callout-body">{children}</div>
    </div>
  )
}
