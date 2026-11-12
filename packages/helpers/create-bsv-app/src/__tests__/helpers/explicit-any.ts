/** Matches an explicit `any` in emitted TypeScript: `: any`, `<any`, `any[]`, `, any>`, `as any`, `= any`, `extends any`. */
export const EXPLICIT_ANY =
  /:\s*any\b|<any\b|\bany\[\]|,\s*any>|\bas any\b|=\s*any\b|\bextends any\b/
