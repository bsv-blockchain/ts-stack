import { describe, expect, it, jest } from '@jest/globals'
import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { OneColor, readOneColorAttributes } from '@bsv/templates'
import type { OneColorAttributes } from '@bsv/templates'
import {
  readSentToken,
  submissionAssets,
  tokenSources,
  transactionTokens,
  tryReadTokenOutput
} from '../ColorPermissionModule.js'
import {
  resolveRequirements,
  routeProvider,
  type RequiredProfileHandler,
  type ResolvedRequirements
} from '../profiles.js'
import {
  isDeployOutput,
  readAnyTokenOutput,
  readProfiledTokenOutput,
  readTokenOutput
} from '../tokenOutputs.js'
import type { ColorOverlayProvider } from '../types.js'
import { A141A, exampleProfile, fixtureDeploy } from './profileFixtures.js'

const REVISION = 'urn:example:color:revision'
const UNKNOWN = 'urn:example:color:unknown'
const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
const text = (value: string): number[] => [0x60 + value.length, ...toArray(value, 'utf8')]

const ex = exampleProfile()
const registry = new Map([[ex.id, ex]])

const script = (hex: string): LockingScript => LockingScript.fromHex(hex)
const op = { txid: 'ab'.repeat(32), vout: 0 }

/** The attributes of a fixture deploy, read at its own outpoint. */
function attrs(hex: string): OneColorAttributes | undefined {
  const { tx } = fixtureDeploy(hex)
  return readProfiledTokenOutput(script(hex), { txid: tx.id('hex'), vout: 0 })!.attributes
}

/** A handler for an id, accepting every descriptor. */
const plain = (
  id: string,
  extra: Partial<RequiredProfileHandler> = {}
): RequiredProfileHandler => ({
  id,
  versions: [1],
  checkDescriptor: () => {},
  ...extra
})

const unsupported = expect.objectContaining({ name: 'UnsupportedProfileError' })
const paramsError = (message: RegExp | string): unknown =>
  expect.objectContaining({
    name: 'ProfileParamsError',
    message:
      typeof message === 'string'
        ? `[ProfileParamsError] ${message}`
        : expect.stringMatching(message)
  })

const fakeProvider = (): ColorOverlayProvider => ({
  spendability: async () => ({ type: 'output-list', outputs: [] }),
  admission: async () => ({ type: 'output-list', outputs: [] }),
  submit: async () => ({})
})

describe('A.141a fixtures', () => {
  it('every BRC-162 fixture reads as a deploy whose asset id is its own txid', () => {
    for (const key of ['U', 'V', 'C', 'D', 'X', 'N'] as const) {
      const { tx, assetId } = fixtureDeploy(A141A[key])
      const token = readProfiledTokenOutput(script(A141A[key]), { txid: tx.id('hex'), vout: 0 })
      expect(token).toMatchObject({ deploy: true, assetId, amount: 9n, encoding: 'brc162' })
    }
  })
})

describe('resolveRequirements (support check)', () => {
  it('A.142 unknown required profile fails closed', () =>
    expect(() => resolveRequirements(attrs(A141A.U), registry)).toThrow(unsupported))

  it('A.143 known identifier with an unsupported version fails', () =>
    expect(() => resolveRequirements(attrs(A141A.V), registry)).toThrow(
      expect.objectContaining({
        name: 'UnsupportedProfileError',
        message: 'BRC-207: the required processing profile version is unsupported'
      })
    ))

  it('A.147 malformed req fails rather than reading as absent', () =>
    expect(() => readProfiledTokenOutput(script(A141A.M), op)).toThrow(
      paramsError('BRC-207: malformed required processing profile map')
    ))

  it('A.148 every required profile must be supported', () =>
    expect(() => resolveRequirements(attrs(A141A.X), registry)).toThrow(unsupported))

  it('A.148 nothing is partially applied: no checkDescriptor runs before the support check passes', () => {
    const checkDescriptor = jest.fn()
    const spied = new Map([[REVISION, { ...exampleProfile(), checkDescriptor }]])
    expect(() => resolveRequirements(attrs(A141A.X), spied)).toThrow(unsupported)
    expect(checkDescriptor).not.toHaveBeenCalled()
  })

  it('A.155 a no-overlay declaration is not a bypass', () =>
    expect(() => resolveRequirements(attrs(A141A.N), registry)).toThrow(unsupported))

  it('A.144 advisory ext of a non-required profile is ignored', () =>
    expect(resolveRequirements(attrs(A141A.D), registry).handlers).toEqual([]))

  it('an advisory ext entry is ignored even when its handler is registered but not required', () => {
    const checkExt = jest.fn(() => {
      throw new Error('must not be called')
    })
    const display = plain('urn:example:display:words', { checkExt })
    const resolved = resolveRequirements(attrs(A141A.D), new Map([[display.id, display]]))
    expect(resolved.handlers).toEqual([])
    expect(checkExt).not.toHaveBeenCalled()
  })

  it('C supported: revision v1 with its own valid ext', () => {
    const resolved = resolveRequirements(attrs(A141A.C), registry)
    expect(resolved.handlers.map(h => h.handler.id)).toEqual([REVISION])
    expect(resolved.handlers[0].descriptor).toEqual({ version: 1, params: null })
    expect([...resolved.req.keys()]).toEqual([REVISION])
  })

  it('checkDescriptor receives its own descriptor and the full req', () => {
    const checkDescriptor = jest.fn()
    const spied = new Map([[REVISION, { ...exampleProfile(), checkDescriptor }]])
    resolveRequirements(attrs(A141A.C), spied)
    expect(checkDescriptor).toHaveBeenCalledTimes(1)
    const [descriptor, req] = checkDescriptor.mock.calls[0] as [
      unknown,
      ReadonlyMap<string, unknown>
    ]
    expect(descriptor).toEqual({ version: 1, params: null })
    expect([...req.keys()]).toEqual([REVISION])
  })

  it('a checkDescriptor rejection propagates', () => {
    const strict = plain(REVISION, {
      checkDescriptor: () => {
        throw new Error('nope')
      }
    })
    const withExt = { ...strict, checkExt: () => {} }
    expect(() => resolveRequirements(attrs(A141A.C), new Map([[REVISION, withExt]]))).toThrow(
      'nope'
    )
  })

  it('own ext entry without a checkExt hook fails', () => {
    const { checkExt: _omit, ...withoutCheckExt } = exampleProfile()
    expect(() =>
      resolveRequirements(attrs(A141A.C), new Map([[REVISION, withoutCheckExt]]))
    ).toThrow(paramsError(/own ext/))
  })

  it('a required profile without its own ext entry passes undefined to checkExt', () => {
    const checkExt = jest.fn()
    const handler = plain(UNKNOWN, { checkExt })
    const resolved = resolveRequirements(attrs(A141A.U), new Map([[UNKNOWN, handler]]))
    expect(resolved.handlers.map(h => h.handler.id)).toEqual([UNKNOWN])
    expect(checkExt).toHaveBeenCalledWith(undefined)
  })

  it('a checkExt rejection of its own ext value propagates', () => {
    const handler = {
      ...exampleProfile(),
      checkExt: () => {
        throw new Error('bad ext')
      }
    }
    expect(() => resolveRequirements(attrs(A141A.C), new Map([[REVISION, handler]]))).toThrow(
      'bad ext'
    )
  })

  it('A.156 legacy JSON deploy declares no profiles', () => {
    const token = readAnyTokenOutput(script(A141A.L), op, readProfiledTokenOutput)!
    expect(token.deploy).toBe(true)
    expect(token.attributes).toBeUndefined()
    expect(resolveRequirements(undefined, registry).handlers).toEqual([])
  })

  it('opaque and empty payloads declare an empty req', () => {
    for (const payload of [[0xff], []]) {
      const token = readProfiledTokenOutput(new OneColor().lock(null, 9n, PKH, payload), op)!
      expect(token.attributes?.payload).toBe(payload.length === 0 ? 'empty' : 'opaque')
      const resolved = resolveRequirements(token.attributes, registry)
      expect(resolved.handlers).toEqual([])
      expect(resolved.req.size).toBe(0)
    }
  })

  it('an output with no payload push reads as an absent payload and declares an empty req', () => {
    const token = readProfiledTokenOutput(new OneColor().lock(null, 9n, PKH), op)!
    expect(token.attributes?.payload).toBe('absent')
    expect(resolveRequirements(token.attributes, registry).handlers).toEqual([])
  })

  it('a malformed ext in a valid map fails in the reader and in resolution', () => {
    const extNull = [0xa1, ...text('ext'), 0xf6]
    const lock = new OneColor().lock(null, 9n, PKH, extNull)
    expect(() => readProfiledTokenOutput(lock, op)).toThrow(
      paramsError('BRC-207: malformed processing profile extension map')
    )
    expect(() => resolveRequirements(readOneColorAttributes(extNull), registry)).toThrow(
      paramsError('BRC-207: malformed processing profile extension map')
    )
  })

  it('resolution fails closed on malformed req attributes it is handed directly', () => {
    const reqNull = [0xa1, ...text('req'), 0xf6]
    expect(() => resolveRequirements(readOneColorAttributes(reqNull), registry)).toThrow(
      paramsError('BRC-207: malformed required processing profile map')
    )
  })

  it('rejects two handlers that both define submissionData or both define admitReceipt', () => {
    const submissionData = async (): Promise<number[]> => [1]
    const admitReceipt = async (): Promise<{ credit: 'pending' }> => ({ credit: 'pending' })
    for (const hook of [{ submissionData }, { admitReceipt }]) {
      const both = new Map([
        [REVISION, { ...exampleProfile(), ...hook }],
        [UNKNOWN, plain(UNKNOWN, hook)]
      ])
      expect(() => resolveRequirements(attrs(A141A.X), both)).toThrow(paramsError(/at most one/))
    }
    const one = new Map([
      [REVISION, { ...exampleProfile(), submissionData }],
      [UNKNOWN, plain(UNKNOWN, { admitReceipt })]
    ])
    expect(resolveRequirements(attrs(A141A.X), one).handlers.map(h => h.handler.id)).toEqual([
      UNKNOWN,
      REVISION
    ])
  })
})

describe('profile-aware reader', () => {
  it('the default reader is unchanged: readTokenOutput still throws UnsupportedProfileError on U', () =>
    expect(() => readTokenOutput(script(A141A.U), op)).toThrow(unsupported))

  it('the default reader is unchanged: a malformed req is not a token for tryReadTokenOutput', () => {
    expect(tryReadTokenOutput(script(A141A.M), op)).toBeUndefined()
    expect(() => tryReadTokenOutput(script(A141A.U), op)).toThrow(unsupported)
  })

  it('tryReadTokenOutput with the profiled reader rethrows ProfileParamsError and reads profiled deploys', () => {
    expect(() => tryReadTokenOutput(script(A141A.M), op, readProfiledTokenOutput)).toThrow(
      paramsError('BRC-207: malformed required processing profile map')
    )
    const token = tryReadTokenOutput(script(A141A.U), op, readProfiledTokenOutput)!
    expect(token.deploy).toBe(true)
    expect(token.attributes?.req.status).toBe('valid')
  })

  it('readProfiledTokenOutput keeps the deploy-at-output-0 rule and reads transfers', () => {
    expect(() => readProfiledTokenOutput(script(A141A.C), { ...op, vout: 1 })).toThrow(
      'BRC-207: a BRC-162 deploy must be output 0'
    )
    const assetId = `${'cd'.repeat(32)}_0`
    const transfer = readProfiledTokenOutput(new OneColor().lock(assetId, 5n, PKH), op)!
    expect(transfer).toMatchObject({ assetId, role: 'value', amount: 5n, deploy: false })
    expect(readProfiledTokenOutput(LockingScript.fromHex('6a'), op)).toBeUndefined()
  })

  it('isDeployOutput and readSentToken take the reader', () => {
    expect(() => isDeployOutput(script(A141A.U), op)).toThrow(unsupported)
    expect(isDeployOutput(script(A141A.U), op, readProfiledTokenOutput)).toBe(true)
    expect(() => readSentToken(script(A141A.U), op)).toThrow(unsupported)
    expect(readSentToken(script(A141A.U), op, readProfiledTokenOutput)?.deploy).toBe(true)
  })

  it('transaction readers forward the reader to inputs and outputs', () => {
    const { tx: deploy, assetId } = fixtureDeploy(A141A.C)
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: deploy,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff
    })
    spend.addOutput({ lockingScript: new OneColor().lock(assetId, 9n, PKH), satoshis: 1 })

    expect(() => tokenSources(spend, new Set())).toThrow(unsupported)
    expect(() => tokenSources(spend, new Set(), true)).toThrow(unsupported)
    expect(tokenSources(spend, new Set(), false, readProfiledTokenOutput)[0].assetId).toBe(assetId)
    expect(tokenSources(spend, new Set(), true, readProfiledTokenOutput)[0].assetId).toBe(assetId)

    expect(() => submissionAssets(spend)).toThrow(unsupported)
    expect(submissionAssets(spend, spend, readProfiledTokenOutput)).toEqual({
      assetIds: [assetId],
      deploy: false
    })

    expect(() => transactionTokens(spend)).toThrow(unsupported)
    for (const json of [false, true]) {
      const tokens = transactionTokens(spend, json, readProfiledTokenOutput)
      expect(tokens.consumed.map(c => c.assetId)).toEqual([assetId])
      expect(tokens.outputs.get(assetId)?.value).toBe(9n)
    }
    const deployTokens = transactionTokens(deploy, false, readProfiledTokenOutput)
    expect(deployTokens.deploy?.attributes?.req.status).toBe('valid')
  })
})

describe('routeProvider', () => {
  const fallback = fakeProvider()
  const assetId = `${'ef'.repeat(32)}_0`
  const resolvedX = (
    revisionProvider?: RequiredProfileHandler['provider'],
    unknownProvider?: RequiredProfileHandler['provider']
  ): ResolvedRequirements =>
    resolveRequirements(
      attrs(A141A.X),
      new Map([
        [REVISION, { ...exampleProfile(), provider: revisionProvider }],
        [UNKNOWN, plain(UNKNOWN, { provider: unknownProvider })]
      ])
    )

  it('0 distinct providers ⇒ fallback; 1 ⇒ it; 2 distinct objects ⇒ ProfileParamsError', () => {
    expect(routeProvider(assetId, resolvedX(), fallback)).toBe(fallback)
    expect(routeProvider(assetId, resolveRequirements(undefined, registry), fallback)).toBe(
      fallback
    )

    const routed = fakeProvider()
    expect(
      routeProvider(
        assetId,
        resolvedX(() => routed),
        fallback
      )
    ).toBe(routed)
    expect(
      routeProvider(
        assetId,
        resolvedX(
          () => routed,
          () => routed
        ),
        fallback
      )
    ).toBe(routed)

    expect(() =>
      routeProvider(
        assetId,
        resolvedX(
          () => routed,
          () => fakeProvider()
        ),
        fallback
      )
    ).toThrow(paramsError(/provider/))
  })

  it('passes the asset id and the handler descriptor to provider()', () => {
    const provider = jest.fn((_assetId: string, _descriptor: unknown) => fallback)
    routeProvider(assetId, resolvedX(provider), fakeProvider())
    expect(provider).toHaveBeenCalledWith(assetId, { version: 1, params: null })
  })
})
