import { expect, it } from '@jest/globals'
import { outputAssert } from '@bsv/sdk'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'

it('uses signed funding fences while preserving unsigned discovery and read-only retained recovery', async () => {
  const f = purchaseBuyerFixture()
  let proofs = 0
  f.partial.validation.fundingPreflight = async (_request, terms) => {
    expect(terms.body.acquisitionId).toBeDefined()
    proofs++
    await Promise.resolve()
    return {
      checkCurrent: () => {
        outputAssert(f.partial.current(), 'Funding view changed')
      }
    }
  }
  const owner = await f.open(true),
    delivered = await owner.buyer.advance()
  expect(proofs).toBe(2)
  expect(f.counts.preflight).toBe(2)
  expect(f.counts.finish).toBe(1)
  await owner.buyer.validate()
  await owner.buyer.stop()
  f.setNow('200')
  const reopened = await f.open()
  expect(await reopened.buyer.recover()).toEqual(delivered)
  expect(proofs).toBe(2)
  expect(f.counts.finish).toBe(1)
})

it('rechecks the retained domain fence after asynchronous planning before persisting or funding an action', async () => {
  const f = purchaseBuyerFixture(),
    plan = f.partial.payment.plan
  let allowed = true
  f.partial.validation.fundingPreflight = async () => ({
    checkCurrent: () => {
      outputAssert(allowed, 'Funding view changed')
    }
  })
  f.partial.payment.plan = async (...args) => {
    const result = await plan(...args)
    allowed = false
    return result
  }
  const owner = await f.open(true)
  await expect(owner.buyer.advance()).rejects.toThrow('Funding view changed')
  expect(f.counts.plan).toBe(1)
  expect(f.counts.finish).toBe(0)
  expect(await owner.buyer.status()).toBe('prepared')
})

it('passes the exact retained fence into the financial owner for its final effect check', async () => {
  const f = purchaseBuyerFixture(),
    finish = f.partial.payment.finish
  let allowed = true
  f.partial.validation.fundingPreflight = async () => ({
    checkCurrent: () => {
      outputAssert(allowed, 'Funding view changed')
    }
  })
  f.partial.payment.finish = async (...args) => {
    await Promise.resolve()
    allowed = false
    return finish(...args)
  }
  const owner = await f.open(true)
  await expect(owner.buyer.advance()).rejects.toThrow('Funding view changed')
  expect(f.counts.finish).toBe(0)
  expect(await owner.buyer.status()).toBe('funding')
})

it.each(['inherited', 'accessor', 'async', 'promise', 'changed', 'missing'] as const)(
  'refuses a %s financial assessment before any wallet action',
  async kind => {
    const f = purchaseBuyerFixture()
    f.partial.validation.fundingPreflight = async () => {
      if (kind === 'missing') return null as never
      if (kind === 'inherited') return Object.create({ checkCurrent: () => undefined })
      if (kind === 'accessor')
        return {
          get checkCurrent() {
            return () => undefined
          }
        }
      if (kind === 'async') return { checkCurrent: async () => undefined }
      if (kind === 'promise') return { checkCurrent: () => Promise.resolve() }
      const assessment = {
        checkCurrent: () => {
          assessment.checkCurrent = () => undefined
        }
      }
      return assessment
    }
    const owner = await f.open(true)
    await expect(owner.buyer.advance()).rejects.toThrow('funding')
    expect(f.counts.plan).toBe(0)
    expect(f.counts.finish).toBe(0)
  }
)

it.each([false, true])(
  'pins the optional funding capability including its absence (%s)',
  async present => {
    const f = purchaseBuyerFixture()
    if (present)
      f.partial.validation.fundingPreflight = async () => ({ checkCurrent: () => undefined })
    const owner = await f.open(true)
    f.partial.validation.fundingPreflight = async () => ({ checkCurrent: () => undefined })
    await expect(owner.buyer.advance()).rejects.toThrow('installed capability changed')
    expect(f.counts.plan).toBe(0)
    expect(f.counts.finish).toBe(0)
  }
)
