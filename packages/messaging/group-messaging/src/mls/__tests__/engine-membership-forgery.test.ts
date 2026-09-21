import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { createCommit, emptyPskIndex, encodeMlsMessage } from 'ts-mls'
import { decodeKeyPackage } from 'ts-mls/keyPackage.js'
import { describe, expect, it } from 'vitest'
import {
  createCredentialIdentity,
  IdentityService,
  newCredentialKeyId
} from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE, type IdentityKey, type KeyPackageBytes } from '../../types.js'
import { resolveCiphersuite } from '../ciphersuite.js'
import { decodeExactly } from '../codec.js'
import { MlsEngine } from '../engine.js'
import { decodeState } from '../state.js'

/**
 * An engine whose credentials claim somebody else's BRC-100 identity.
 *
 * The forgery is exactly the one the library exists to stop: the leaf signature
 * is genuine — `generateKeyPackageWithKey` signs it with the MLS key it just
 * generated — and the KeyPackage is structurally perfect. Only the attestation
 * inside the credential is wrong: it is signed by the attacker's wallet while
 * naming the victim's identity key, so deriving the attestation key from the
 * *claimed* identity is what exposes it.
 *
 * `IdentityService` has a private constructor and a private wallet field, so
 * standing in for it means a cast. Nothing else here is faked.
 */
const forgingEngine = async (attacker: KeyDeriver, claimed: IdentityKey): Promise<MlsEngine> => {
  const wallet = await IdentityService.open(attacker)
  const identity = {
    identityKey: claimed,
    createCredential: async (input: {
      ciphersuite: typeof DEFAULT_CIPHERSUITE
      mlsSignaturePublicKey: Uint8Array
    }) => {
      const keyId = newCredentialKeyId()
      return {
        keyId,
        credential: await createCredentialIdentity({
          sign: async data => wallet.sign(keyId, data),
          identityKey: claimed,
          keyId,
          ciphersuite: input.ciphersuite,
          mlsSignaturePublicKey: input.mlsSignaturePublicKey
        })
      }
    }
  } as unknown as IdentityService
  return new MlsEngine({ identity, ciphersuite: DEFAULT_CIPHERSUITE })
}

const honestEngine = async (): Promise<MlsEngine> =>
  new MlsEngine({
    identity: await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom())),
    ciphersuite: DEFAULT_CIPHERSUITE
  })

/**
 * A Commit built with `ts-mls`'s credential check disabled — the peer whose
 * client does not validate what it adds. Everything else is a real commit from
 * a real member, so the receiving side's `validateCredential` is the only thing
 * left standing between the forged leaf and the roster.
 */
const commitWithoutAuthentication = async (
  state: Uint8Array,
  keyPackage: KeyPackageBytes
): Promise<Uint8Array> => {
  const decoded = decodeState(state, DEFAULT_CIPHERSUITE)
  const result = await createCommit(
    {
      state: {
        ...decoded,
        clientConfig: {
          ...decoded.clientConfig,
          authService: { validateCredential: async () => true }
        }
      },
      cipherSuite: await resolveCiphersuite(DEFAULT_CIPHERSUITE),
      pskIndex: emptyPskIndex
    },
    {
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: 'add',
          add: { keyPackage: decodeExactly(decodeKeyPackage, keyPackage, 'KeyPackage') }
        }
      ]
    }
  )
  return encodeMlsMessage(result.commit)
}

describe("a KeyPackage claiming a third party's identity", () => {
  it('is refused by addMembers', async () => {
    const carol = new KeyDeriver(PrivateKey.fromRandom())
    const mallory = await forgingEngine(new KeyDeriver(PrivateKey.fromRandom()), carol.identityKey)
    const forged = await mallory.createKeyPackage()

    // Structurally sound, and it names Carol. Nothing but the attestation check
    // stands between this and a group Alice believes Carol is in.
    expect(mallory.identityForKeyPackage(forged.keyPackage)).toBe(carol.identityKey)

    const alice = await honestEngine()
    const aliceKp = await alice.createKeyPackage()
    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })

    await expect(
      alice.addMembers({ state: created.state, keyPackages: [forged.keyPackage] })
    ).rejects.toThrow()
  })

  it("is refused by joinFromWelcome when it sits in the Welcome's ratchet tree", async () => {
    const carol = new KeyDeriver(PrivateKey.fromRandom())
    const mallory = await forgingEngine(new KeyDeriver(PrivateKey.fromRandom()), carol.identityKey)
    const forged = await mallory.createKeyPackage()

    // Mallory runs her own client, so nothing stops her building a group on the
    // forged leaf: the guard that matters is the joiner's, not the committer's.
    const group = await mallory.createGroup({
      keyPackage: forged.keyPackage,
      privateKeyPackage: forged.privateKeyPackage
    })

    const victim = await honestEngine()
    const victimKp = await victim.createKeyPackage()
    const added = await mallory.addMembers({
      state: group.state,
      keyPackages: [victimKp.keyPackage]
    })

    // The ratchet tree inside the Welcome carries Mallory's leaf, credentialled
    // as Carol. Accepting it puts a forged member in the victim's roster.
    await expect(
      victim.joinFromWelcome({
        welcome: added.welcome,
        keyPackage: victimKp.keyPackage,
        privateKeyPackage: victimKp.privateKeyPackage
      })
    ).rejects.toThrow()
  })

  it("is refused by process when it arrives inside another member's Commit", async () => {
    const carol = new KeyDeriver(PrivateKey.fromRandom())
    const mallory = await forgingEngine(new KeyDeriver(PrivateKey.fromRandom()), carol.identityKey)
    const forged = await mallory.createKeyPackage()

    const alice = await honestEngine()
    const bob = await honestEngine()
    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()

    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const added = await alice.addMembers({
      state: created.state,
      keyPackages: [bobKp.keyPackage]
    })
    const joined = await bob.joinFromWelcome({
      welcome: added.welcome,
      keyPackage: bobKp.keyPackage,
      privateKeyPackage: bobKp.privateKeyPackage
    })

    // Neither of the other two seams is in play: Bob already holds the group,
    // and the forged leaf reaches him as a tree mutation inside a Commit signed
    // by a member he trusts.
    const commit = await commitWithoutAuthentication(added.state, forged.keyPackage)

    // Matched on the reason, not just "it threw": an epoch or codec failure
    // would pass a bare rejection assertion without the guard ever running.
    await expect(bob.process({ state: joined.state, message: commit })).rejects.toThrow(
      /credential/i
    )
  })

  it('does not disturb a legitimately minted KeyPackage', async () => {
    const alice = await honestEngine()
    const bob = await honestEngine()
    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()

    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const added = await alice.addMembers({
      state: created.state,
      keyPackages: [bobKp.keyPackage]
    })
    const joined = await bob.joinFromWelcome({
      welcome: added.welcome,
      keyPackage: bobKp.keyPackage,
      privateKeyPackage: bobKp.privateKeyPackage
    })

    expect((await bob.info(joined.state)).members).toHaveLength(2)
  })
})
