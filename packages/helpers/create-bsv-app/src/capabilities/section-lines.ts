/** Joins the AGENTS.md lines that apply to this layout; `false` entries are dropped. */
export function sectionLines(...items: Array<string | false>): string {
  return items.filter((l): l is string => l !== false).join('\n')
}
