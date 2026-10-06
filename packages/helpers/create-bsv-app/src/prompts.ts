import { listCapabilities } from './registry.js'
import { remainingCapabilityIds, mergeCapabilityIds } from './config/project-manifest.js'
import type { ProjectManifest } from './config/project-manifest.js'
import { configSchema, isFieldVisible } from './config/schema.js'
import type { ConfigField, FieldOption } from './config/schema.js'
import { seedDraft, resolveDraft } from './config/draft.js'
import type { ConfigDraft } from './config/draft.js'
import type { ProjectConfig } from './config/model.js'

/** `initial` is the pre-selected value: cursor for select/toggle, ticked boxes for multiselect. */
export type Ask = (
  field: ConfigField,
  options: FieldOption[],
  initial: string | boolean | string[] | undefined
) => Promise<unknown>
export type ConfigProvider = (ctx: {
  existing: ProjectManifest | null
  flags: ConfigDraft
}) => Promise<ProjectConfig>

/** Options offered for `field` in `mode`; the `--ui` page offers the same per mode. */
export function optionsFor(
  field: ConfigField,
  existing: ProjectManifest | null,
  mode: 'new' | 'add'
): FieldOption[] {
  if (field.key === 'capabilities') {
    const all = listCapabilities()
    let ids: string[]
    if (mode === 'add') {
      ids =
        existing == null
          ? all.map(c => c.id)
          : remainingCapabilityIds(
              existing,
              all.map(c => c.id)
            )
    } else {
      // new mode: defaultSelected base capabilities are always included (floor) → don't offer them as toggles
      ids = all.filter(c => c.defaultSelected !== true).map(c => c.id)
    }
    return all
      .filter(c => ids.includes(c.id))
      .map(c => ({ value: c.id, label: c.title, hint: c.description }))
  }
  return field.options ?? []
}

export async function runPrompts(
  ctx: { existing: ProjectManifest | null; flags: ConfigDraft },
  ask: Ask
): Promise<ProjectConfig> {
  const draft: ConfigDraft = seedDraft(ctx.existing, ctx.flags)
  for (const section of configSchema) {
    for (const field of section.fields) {
      if (
        field.key !== 'capabilities' &&
        (draft as Record<string, unknown>)[field.key] !== undefined
      )
        continue // set by flags/seed
      if (!isFieldVisible(field, draft as Record<string, unknown>)) continue
      const mode = draft.mode ?? 'new'
      const options = optionsFor(field, ctx.existing, mode)
      // new mode pre-ticks every offered capability; add mode never pre-ticks onto an existing project
      let initial: string | boolean | string[] | undefined = field.default
      if (field.key === 'capabilities') initial = mode === 'new' ? options.map(o => o.value) : []
      const value = await ask(field, options, initial)
      if (field.key === 'capabilities') {
        ;(draft as Record<string, unknown>).capabilities = mergeCapabilityIds(
          (draft.capabilities as string[]) ?? [],
          value as string[]
        )
      } else {
        ;(draft as Record<string, unknown>)[field.key] = value
      }
    }
  }
  return resolveDraft(draft)
}

export const interactiveConfigPrompt: ConfigProvider = async ctx => {
  const p = await import('@clack/prompts') // lazy: keep clack out of the Jest transform
  p.intro('create-bsv-app')
  const ask: Ask = async (field, options, initial) => {
    let res: unknown
    if (field.type === 'text')
      res = await p.text({
        message: field.label,
        placeholder: typeof field.default === 'string' ? field.default : undefined
      })
    else if (field.type === 'toggle')
      res = await p.confirm({ message: field.label, initialValue: initial === true })
    else if (field.type === 'multiselect')
      res = await p.multiselect({
        message: field.label,
        options,
        initialValues: Array.isArray(initial) ? initial : [],
        required: false
      })
    else
      res = await p.select({
        message: field.label,
        options,
        initialValue: typeof initial === 'string' ? initial : undefined
      })
    if (p.isCancel(res)) {
      p.cancel('Cancelled')
      process.exit(1)
    }
    return res
  }
  const config = await runPrompts(ctx, ask)
  p.outro('Done')
  return config
}
