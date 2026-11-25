import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PasswordHandler from '../src/components/PasswordHandler'
import FundingHandler from '../src/components/FundingHandler'
import PeerPayRoute from '../src/pages/Dashboard/Transfer'

const fixture = vi.hoisted(() => ({
  retrievePassword: undefined as
    | ((reason: string, verify: (value: string) => boolean | Promise<boolean>) => Promise<string>)
    | undefined,
  requestFunding: undefined as
    ((outputs: unknown[], wallet: object, originator: string) => Promise<void>) | undefined,
  send: vi.fn()
}))

vi.mock('../src/WalletContext', async () => {
  const { createContext } = await import('react')
  return {
    WalletContext: createContext({
      managers: {
        permissionsManager: {},
        walletManager: { listProfiles: async () => [] }
      },
      adminOriginator: 'wallet.test',
      setPasswordRetriever: (update: (current: unknown) => typeof fixture.retrievePassword) => {
        fixture.retrievePassword = update(fixture.retrievePassword)
      },
      setWalletFunder: (update: (current: unknown) => typeof fixture.requestFunding) => {
        fixture.requestFunding = update(fixture.requestFunding)
      }
    })
  }
})

vi.mock('../src/UserContext', async () => {
  const { createContext } = await import('react')
  return {
    UserContext: createContext({
      isFocused: async () => true,
      onFocusRequested: async () => {},
      onFocusRelinquished: async () => {}
    })
  }
})

vi.mock('@bsv/message-box-client', () => ({
  PeerPayClient: class {
    sendLivePayment = fixture.send
    listIncomingPayments = async () => []
  }
}))

vi.mock('@bsv/amountinator', () => ({
  CurrencyConverter: class {
    initialize = async () => {}
    getCurrencySymbol = () => '$'
    convertToSatoshis = async (value: number) => value * 100
  }
}))

afterEach(cleanup)

test('queues password requests and ignores a canceled verification that finishes late', async () => {
  render(<PasswordHandler />)
  const slow = Promise.withResolvers<boolean>()
  let first!: Promise<string>
  let second!: Promise<string>
  await act(async () => {
    first = fixture.retrievePassword!('First request', () => slow.promise).catch(
      error => error.message
    )
    second = fixture.retrievePassword!('Second request', value => value === 'second password')
  })
  expect(screen.getByText('First request')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'first password' } })
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(await first).toMatch(/closed password dialog/)
  expect(screen.getByText('Second request')).toBeTruthy()
  await act(async () => slow.resolve(true))
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'second password' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'OK' })))
  expect(await second).toBe('second password')
})

test('lets registration continue when funding is skipped without internalizing payment', async () => {
  render(<FundingHandler />)
  const internalizeAction = vi.fn()
  let funding!: Promise<void>
  await act(async () => {
    funding = fixture.requestFunding!(
      [],
      {
        getPublicKey: async () => ({ publicKey: 'test identity' }),
        internalizeAction
      },
      'wallet.test'
    )
  })
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
  await expect(funding).resolves.toBeUndefined()
  expect(internalizeAction).not.toHaveBeenCalled()
})

test('keeps one payment in flight and requires a new amount after success', async () => {
  const payment = Promise.withResolvers<void>()
  fixture.send.mockReturnValueOnce(payment.promise)
  render(<PeerPayRoute defaultRecipient="test-recipient" />)
  const input = screen.getByLabelText('Enter Amount') as HTMLInputElement
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  fireEvent.change(input, { target: { value: '2' } })
  await waitFor(() => expect(send.disabled).toBe(false))
  await act(async () => {
    fireEvent.click(send)
    fireEvent.click(send)
  })
  expect(fixture.send.mock.calls).toEqual([[{ recipient: 'test-recipient', amount: 200 }]])
  await act(async () => payment.resolve())
  expect(input.value).toBe('')
  expect(send.disabled).toBe(true)
  fireEvent.click(send)
  expect(fixture.send).toHaveBeenCalledTimes(1)
})
