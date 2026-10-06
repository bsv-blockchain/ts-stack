import { beforeEach, describe, expect, jest, test } from '@jest/globals'

const intro = jest.fn()
const outro = jest.fn()
const cancel = jest.fn()
const isCancel = jest.fn(() => false)
const text = jest.fn(async () => 'interactive-demo')
const confirm = jest.fn(async () => true)
const multiselect = jest.fn(async (_opts: { initialValues?: string[] }) => ['wallet-login'])
const select = jest.fn(async ({ message }: { message: string }) => {
  const answers: Record<string, string> = {
    'Create a new project or add to an existing one?': 'new',
    'Starting point': 'custom',
    Frontend: 'react',
    'React variant': 'react-ts',
    Backend: 'express',
    'Package manager': 'pnpm',
    Network: 'test'
  }
  return answers[message]
})

jest.mock('@clack/prompts', () => ({
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  text
}))

import { interactiveConfigPrompt } from '../prompts'

describe('interactiveConfigPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('maps every prompt type into a complete configuration', async () => {
    const config = await interactiveConfigPrompt({ existing: null, flags: {} })

    expect(config).toMatchObject({
      mode: 'new',
      name: 'interactive-demo',
      packageManager: 'pnpm',
      network: 'test',
      stack: {
        frontend: { framework: 'react', variant: 'react-ts' },
        backend: { framework: 'express' }
      }
    })
    expect(config.capabilities).toEqual(expect.arrayContaining(['wallet-connect', 'wallet-login']))
    expect(intro).toHaveBeenCalledWith('create-bsv-app')
    expect(outro).toHaveBeenCalledWith('Done')
    expect(text).toHaveBeenCalled()
    expect(confirm).toHaveBeenCalled()
    expect(multiselect).toHaveBeenCalled()
    expect(select).toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  test('passes the full-project defaults as clack initial values', async () => {
    await interactiveConfigPrompt({ existing: null, flags: {} })

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Frontend', initialValue: 'react' })
    )
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Backend', initialValue: 'express' })
    )
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: expect.arrayContaining(['wallet-login']) })
    )
  })

  test('reports cancellation and exits without resolving a partial configuration', async () => {
    isCancel.mockReturnValueOnce(true)
    const exit = jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit:${String(code)}`)
    })

    await expect(interactiveConfigPrompt({ existing: null, flags: {} })).rejects.toThrow('exit:1')
    expect(cancel).toHaveBeenCalledWith('Cancelled')
    expect(outro).not.toHaveBeenCalledWith('Done')

    exit.mockRestore()
  })
})
