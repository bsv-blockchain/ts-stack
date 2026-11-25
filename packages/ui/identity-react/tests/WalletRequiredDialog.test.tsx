import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WalletRequiredDialog } from '../src/components/WalletRequiredDialog'

afterEach(cleanup)

it('keeps a closed prompt out of the page and preserves the host name and close action', () => {
  const onClose = vi.fn()
  const { rerender } = render(
    <WalletRequiredDialog appName="Example host" open={false} onClose={onClose} />
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onClose).not.toHaveBeenCalled()

  rerender(<WalletRequiredDialog appName="Example host" open onClose={onClose} />)
  const prompt = screen.getByRole('dialog', { name: 'Connect a BRC-100 wallet' })
  expect(within(prompt).getByText(/Example host needs a compatible wallet/)).toBeTruthy()
  expect(within(prompt).getByRole('link', { name: 'Find a wallet' })).toBeTruthy()
  fireEvent.click(within(prompt).getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
