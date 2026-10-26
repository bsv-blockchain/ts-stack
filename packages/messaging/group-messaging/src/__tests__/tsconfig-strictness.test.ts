import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Three settings this package is stricter about than the house preset.
 *
 * They must be declared in the package's own `tsconfig.json` rather than
 * inherited, because the root config they came from does not travel with
 * `packages/`. A package that moves and silently resolves against a preset
 * setting the first two to `false` still compiles — it just stops catching the
 * indexing and optional-property mistakes invariants 1 and 4 rest on, which is
 * the kind of loss nothing reports.
 */
const DECLARED_HERE = [
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'verbatimModuleSyntax'
] as const

describe("the package's own TypeScript strictness", () => {
  it('is declared in this package, not inherited from a root that will not move with it', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8')
    ) as { compilerOptions?: Record<string, unknown> }

    for (const flag of DECLARED_HERE) {
      expect(config.compilerOptions?.[flag], `${flag} must be set in this tsconfig`).toBe(true)
    }
  })

  /**
   * The two below assert the flags are in *effect*, not merely written down.
   * Each `@ts-expect-error` becomes an unused-directive error if its flag is
   * off, so `pnpm typecheck` fails rather than the assertion.
   */
  it('makes an index access possibly undefined', () => {
    const items: number[] = [1]
    // @ts-expect-error noUncheckedIndexedAccess widens this to number | undefined
    const first: number = items[0]

    expect(first).toBe(1)
  })

  it('refuses an explicit undefined for an optional property', () => {
    interface Optional {
      value?: string
    }
    // @ts-expect-error exactOptionalPropertyTypes separates "absent" from "undefined"
    const record: Optional = { value: undefined }

    expect(record.value).toBeUndefined()
  })
})
