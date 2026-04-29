/// <reference types="vite/client" />

declare module '*.md' {
  import type { ComponentType } from 'react'
  const Component: ComponentType
  export default Component
  export const frontmatter: Record<string, unknown>
}
