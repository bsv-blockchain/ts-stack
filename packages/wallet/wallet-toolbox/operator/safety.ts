import path from 'node:path'

import type { Chain } from '../out/src'
import { OperatorCommand, OperatorIo, OperatorPlan, ParsedOperatorArguments } from './contracts'

const GLOBAL_OPTIONS = new Set(['allow-production', 'apply', 'confirm', 'help'])
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/

function parseOption(argv: string[], index: number, options: Map<string, string | true>): number {
  const token = argv[index]
  const separator = token.indexOf('=')
  const name = token.slice(2, separator === -1 ? undefined : separator)
  if (name === '') throw new Error('Operator option names cannot be empty')
  if (options.has(name)) {
    throw new Error(`Operator option "--${name}" was provided more than once`)
  }

  if (separator !== -1) {
    const value = token.slice(separator + 1)
    if (value === '') {
      throw new Error(`Operator option "--${name}" requires a value`)
    }
    options.set(name, value)
    return index
  }

  const next = argv[index + 1]
  if (next !== undefined && !next.startsWith('--')) {
    options.set(name, next)
    return index + 1
  }
  options.set(name, true)
  return index
}

export function parseOperatorArguments(argv: string[]): ParsedOperatorArguments {
  const options = new Map<string, string | true>()
  let command: string | undefined
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      if (command !== undefined) throw new Error(`Unexpected positional argument "${token}"`)
      command = token
      index++
      continue
    }
    index = parseOption(argv, index, options) + 1
  }

  return { command, options }
}

export function parseChain(value: string): Chain {
  if (value !== 'main' && value !== 'test') {
    throw new Error('Operator option "--chain" must be "main" or "test"')
  }
  return value
}

export function environmentName(value: string, option: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error(`Operator option "--${option}" must name an uppercase environment variable`)
  }
  return value
}

export function booleanOption(options: ReadonlyMap<string, string | true>, name: string): boolean {
  const value = options.get(name)
  if (value !== undefined && value !== true) {
    throw new Error(`Operator option "--${name}" does not accept a value`)
  }
  return value === true
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable "${name}" is not set`)
  }
  return value
}

export function optionString(options: ReadonlyMap<string, string | true>, name: string, fallback?: string): string {
  const value = options.get(name) ?? fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Operator option "--${name}" requires a non-empty value`)
  }
  return value
}

export function optionInteger(
  options: ReadonlyMap<string, string | true>,
  name: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const raw = options.get(name)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`Operator option "--${name}" must be an integer from ${bounds.min} through ${bounds.max}`)
  }
  return value
}

export function explicitOutputPath(
  options: ReadonlyMap<string, string | true>,
  name: string,
  cwd = process.cwd()
): string {
  const requested = optionString(options, name)
  const resolved = path.resolve(cwd, requested)
  const root = path.parse(resolved).root
  if (resolved === root || resolved === path.resolve(cwd)) {
    throw new Error(`Operator option "--${name}" must identify a dedicated output directory`)
  }
  return resolved
}

function validateOptions(command: OperatorCommand, options: ReadonlyMap<string, string | true>) {
  for (const name of options.keys()) {
    if (!GLOBAL_OPTIONS.has(name) && !command.allowedOptions.has(name)) {
      throw new Error(`Unknown option "--${name}" for operator command "${command.name}"`)
    }
  }
}

export function authorizePlan(command: OperatorCommand, options: ReadonlyMap<string, string | true>): OperatorPlan {
  validateOptions(command, options)
  const plan = command.plan(options)
  if (plan.command !== command.name) {
    throw new Error(`Operator command "${command.name}" returned a mismatched plan`)
  }
  return plan
}

export function assertExecutionAuthorized(plan: OperatorPlan, options: ReadonlyMap<string, string | true>): void {
  if (options.get('apply') !== true) {
    throw new Error('Execution requires the exact boolean option "--apply"')
  }
  if (options.get('confirm') !== plan.command) {
    throw new Error(`Execution requires "--confirm ${plan.command}"`)
  }
  if (plan.requiresProductionApproval && options.get('allow-production') !== true) {
    throw new Error('This plan requires the exact boolean option "--allow-production"')
  }
}

export async function runOperatorCommand(
  argv: string[],
  commands: ReadonlyMap<string, OperatorCommand>,
  io: OperatorIo
): Promise<number> {
  try {
    const parsed = parseOperatorArguments(argv)
    if (parsed.command === undefined || parsed.options.get('help') === true) {
      io.stdout(
        JSON.stringify({
          mode: 'help',
          commands: [...commands.values()].map(command => ({
            name: command.name,
            description: command.description
          }))
        })
      )
      return 0
    }

    const command = commands.get(parsed.command)
    if (command === undefined) throw new Error(`Unknown operator command "${parsed.command}"`)
    const plan = authorizePlan(command, parsed.options)

    if (parsed.options.get('apply') !== true) {
      io.stdout(JSON.stringify({ mode: 'dry-run', plan }))
      return 0
    }

    assertExecutionAuthorized(plan, parsed.options)
    const evidence = await command.execute(parsed.options, plan)
    io.stdout(JSON.stringify({ mode: 'applied', plan, evidence }))
    return 0
  } catch (error: unknown) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}
