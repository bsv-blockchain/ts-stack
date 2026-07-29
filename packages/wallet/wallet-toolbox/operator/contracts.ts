export type OperatorEffect = 'local-write' | 'read-only' | 'remote-write'

export interface OperatorPlan {
  command: string
  description: string
  effect: OperatorEffect
  requiresProductionApproval: boolean
  parameters: Record<string, boolean | number | string>
}

export interface OperatorEvidence {
  command: string
  startedAt: string
  completedAt: string
  result: Record<string, boolean | number | string>
}

export interface OperatorCommand {
  name: string
  description: string
  allowedOptions: ReadonlySet<string>
  plan: (options: ReadonlyMap<string, string | true>) => OperatorPlan
  execute: (options: ReadonlyMap<string, string | true>, plan: OperatorPlan) => Promise<OperatorEvidence>
}

export interface OperatorIo {
  stdout: (value: string) => void
  stderr: (value: string) => void
}

export interface ParsedOperatorArguments {
  command?: string
  options: Map<string, string | true>
}
