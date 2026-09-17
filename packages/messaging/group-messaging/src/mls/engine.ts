import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  decodeMlsMessage,
  defaultCapabilities,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  joinGroup,
  createGroup as mlsCreateGroup,
  processMessage,
  type Capabilities,
  type CiphersuiteImpl,
  type ClientState,
  type CreateCommitOptions,
  type KeyPackage,
  type PrivateMessage,
  type Proposal,
  type RatchetTree
} from 'ts-mls'
import {
  decodeKeyPackage,
  encodeKeyPackage,
  makeKeyPackageRef,
  verifyKeyPackage
} from 'ts-mls/keyPackage.js'
import { verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js'
import { decryptSenderData } from 'ts-mls/privateMessage.js'
import { decodeWelcome, encodeWelcome } from 'ts-mls/welcome.js'
import { toHex } from '../bytes.js'
import { GroupMessagingError } from '../errors.js'
import { decodeCredentialIdentity, IdentityService } from '../identity/index.js'
import {
  DEFAULT_CIPHERSUITE,
  SUPPORTED_CIPHERSUITES,
  type IdentityKey,
  type KeyPackageBytes,
  type KeyPackageOptions,
  type KeyPackageRef,
  type Member,
  type MintedKeyPackage,
  type MlsCiphersuiteName,
  type MlsGroupId,
  type PrivateKeyPackageBytes
} from '../types.js'
import { clientConfigFor } from './authentication.js'
import { resolveCiphersuite } from './ciphersuite.js'
import { decodeExactly } from './codec.js'
import {
  asKeyPackageBytes,
  decodePrivateKeyPackage,
  encodePrivateKeyPackage
} from './key-package-codec.js'
import { decodeState, encodeState } from './state.js'

const DEFAULT_LIFETIME_SECONDS = 90 * 24 * 60 * 60

const GROUP_ID_BYTES = 32

/**
 * Used for every commit, not only the ones that add members.
 *
 * `ratchetTreeExtension` is read only where a Welcome is built, so a
 * remove-only or update-only commit ignores it — but a commit that mixes an Add
 * with a Remove would otherwise produce a Welcome no newcomer can join. The
 * extension rides in the GroupInfo rather than the GroupContext, so joiners need
 * no extra advertised capability for it.
 */
const COMMIT_OPTIONS: CreateCommitOptions = { ratchetTreeExtension: true }

/**
 * We advertise both supported suites and only the basic credential type: x509
 * is not something a BRC-100 wallet can produce.
 */
const capabilitiesFor = (): Capabilities => ({
  ...defaultCapabilities(),
  ciphersuites: [
    'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
  ],
  credentials: ['basic']
})

/**
 * Decode a KeyPackage and refuse one minted for another ciphersuite.
 *
 * `ts-mls` writes the engine's suite into the GroupContext without consulting
 * `keyPackage.cipherSuite`, so a mismatch is accepted here and surfaces much
 * later as a credential that fails to validate — the attestation preimage binds
 * the suite name, so a perfectly well-formed credential is rejected for reasons
 * that have nothing to do with it.
 */
const parseKeyPackage = (bytes: KeyPackageBytes, expected: MlsCiphersuiteName): KeyPackage => {
  const keyPackage = decodeExactly(decodeKeyPackage, bytes, 'KeyPackage')
  if (keyPackage.cipherSuite !== expected) {
    throw new GroupMessagingError(
      `KeyPackage is for ciphersuite ${keyPackage.cipherSuite}, this client uses ${expected}`
    )
  }
  return keyPackage
}

/**
 * A lifetime bound is an unauthenticated u64 off the wire, and most of that
 * range is outside what `Date` can represent. A bound nobody can read costs its
 * own field only, so the rest of the description still renders.
 */
const describeLifetimeBound = (seconds: bigint): string => {
  const millis = Number(seconds) * 1000
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? new Date(millis).toISOString()
    : 'unparseable'
}

/**
 * Every member's identity comes from their credential, which the
 * authentication service already verified when the tree was validated.
 *
 * Leaf indices come from the ratchet tree's own numbering (leaf `n` lives at
 * node `2n`) rather than from a position in a filtered list, so a tree with
 * blanked leaves still reports the indices MLS removes by.
 *
 * Takes the tree rather than the state because a message from an earlier epoch
 * must be read against the tree of *that* epoch: `ts-mls` reuses blanked leaves
 * for later joiners, so the live tree can answer with the wrong member.
 */
const membersOf = (tree: RatchetTree): Member[] => {
  const members: Member[] = []
  tree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf') return
    if (nodeIndex % 2 !== 0) {
      throw new GroupMessagingError(`Leaf node at odd ratchet tree index ${nodeIndex}`)
    }
    const leafIndex = nodeIndex / 2
    if (node.leaf.credential.credentialType !== 'basic') {
      throw new GroupMessagingError(`Member at leaf ${leafIndex} has a non-basic credential`)
    }
    const parsed = decodeCredentialIdentity(node.leaf.credential.identity)
    members.push({ identityKey: parsed.identityKey, leafIndex, keyId: parsed.keyId })
  })
  return members
}

/**
 * The exact sender of an application message, not a guess.
 *
 * `ProcessMessageResult` does not name the sender, and diffing the roster only
 * works for a group of two. Every `PrivateMessage` carries its sender's leaf
 * index in encrypted sender data, and the key that opens it is on the state.
 *
 * Both the key that opens that data and the tree that gives the leaf a name are
 * epoch-scoped, and they are taken from one branch on purpose. A message from
 * an epoch this client has left is decrypted with the retained
 * `historicalReceiverData`, and it must be *named* against that epoch's tree
 * too: `addLeafNode` fills the first blank leaf before extending the tree, so
 * whoever joins after a removal sits on the removed member's leaf, and the live
 * roster would attribute the older message to the newcomer.
 *
 * `unprotectPrivateMessage` already opened this header once inside
 * `processMessage`; opening it again is the price of `ProcessMessageResult` not
 * surfacing the leaf index, not an oversight.
 */
const senderOf = async (
  state: ClientState,
  privateMessage: PrivateMessage,
  suite: CiphersuiteImpl
): Promise<IdentityKey> => {
  const isCurrentEpoch = privateMessage.epoch === state.groupContext.epoch
  const historical = isCurrentEpoch
    ? undefined
    : state.historicalReceiverData.get(privateMessage.epoch)
  if (!isCurrentEpoch && historical === undefined) {
    throw new GroupMessagingError(`No receiver data for epoch ${privateMessage.epoch}`)
  }

  const secret = historical?.senderDataSecret ?? state.keySchedule.senderDataSecret
  const tree = historical?.ratchetTree ?? state.ratchetTree

  const senderData = await decryptSenderData(privateMessage, secret, suite)
  if (senderData === undefined) throw new GroupMessagingError('Could not decrypt sender data')

  const sender = membersOf(tree).find(member => member.leafIndex === senderData.leafIndex)
  if (sender === undefined) {
    throw new GroupMessagingError(
      `No member at leaf ${senderData.leafIndex} in epoch ${privateMessage.epoch}`
    )
  }
  return sender.identityKey
}

/** What {@link MlsEngine.process} found in an inbound message. */
export type MlsProcessResult =
  | {
      kind: 'application'
      state: Uint8Array
      sender: IdentityKey
      /** The epoch the message was sent in, which may predate the current one. */
      epoch: bigint
      plaintext: Uint8Array
    }
  | { kind: 'commit'; state: Uint8Array; added: IdentityKey[]; removed: IdentityKey[] }
  | { kind: 'proposal'; state: Uint8Array }

/**
 * What the engine can say about a group from its state alone.
 *
 * Deliberately not `ChatInfo`: the chat identifier and name belong to the
 * caller, and the engine has no way to know them.
 */
export interface MlsGroupSummary {
  mlsGroupId: MlsGroupId
  epoch: bigint
  members: Member[]
}

export interface MlsEngineOptions {
  identity: IdentityService
  ciphersuite?: MlsCiphersuiteName
}

/** A KeyPackage as plain data, for {@link MlsEngine.describeKeyPackage}. */
/**
 * A KeyPackage's contents, decoded and nothing more.
 *
 * Every field here is read out of the bytes. Nothing is a verdict: no signature
 * is checked, no binding is judged, and a description says only what the
 * KeyPackage claims about itself. Ask {@link MlsEngine.verifyKeyPackage} for the
 * judgments, and keep them visibly separate from the facts — a reader can then
 * tell which fields came off the wire and which came from our own checks.
 *
 * Hex throughout, so every value can be recomputed by hand.
 */
export interface KeyPackageDescription {
  ref?: KeyPackageRef
  ciphersuite?: MlsCiphersuiteName
  /** The HPKE public key a Welcome is sealed to. */
  initKey?: string
  /** The KeyPackage's own signature, over the init key and the leaf node. */
  signature?: string
  leafNode?: {
    signaturePublicKey: string
    encryptionKey: string
    /** Over the credential, the capabilities, the lifetime and both keys. */
    signature: string
    leafNodeSource: string
    credential: {
      type: string
      /** The whole `BasicCredential.identity` field, undecoded. */
      identity: string
      /** The fields below are absent when that field does not decode. */
      version?: number
      identityKey?: IdentityKey
      keyId?: string
      /** The wallet's DER ECDSA signature, as it travels in the credential. */
      signature?: string
    }
    capabilities: { ciphersuites: string[]; credentials: string[] }
    /** ISO 8601, or `"unparseable"` for a bound no `Date` can represent. */
    lifetime: { notBefore: string; notAfter: string }
  }
  error?: string
}

/**
 * The judgments, kept apart from {@link KeyPackageDescription}'s facts.
 *
 * `credentialBinding` says a BRC-100 identity vouched for this MLS signature
 * key — and nothing else. It does not cover the lifetime or this particular
 * KeyPackage, and anyone may attest to a public key they did not generate, so
 * on its own it does not make a KeyPackage anybody's.
 *
 * `leafSignature` is what does. It is made by the private half of the leaf's
 * signature key over the credential and the lifetime, so a captured KeyPackage
 * re-labelled with someone else's credential fails here even though the
 * credential itself verifies. A binding that holds beside a leaf signature that
 * does not is exactly what a re-label looks like, and MLS refuses it.
 */
export interface KeyPackageVerification {
  credentialBinding: boolean
  leafSignature: boolean
  keyPackageSignature: boolean
  /**
   * The suite the KeyPackage claims, reported as a fact rather than used as
   * one. `credentialBinding` is judged under this engine's own suite: a
   * credential does not get to choose the authority that validates it, so a
   * KeyPackage declaring a suite this engine does not serve cannot be vouched
   * for even when it is internally consistent.
   */
  declaredCiphersuite?: string
  /** Why a check could not be run at all, as opposed to running and failing. */
  error?: string
}

/**
 * MLS group cryptography, behind an API shaped for chat rather than for RFC
 * 9420.
 *
 * Wraps `ts-mls` so nothing above this file imports it, which keeps the engine
 * choice reversible (spec §4 leaves OpenMLS-WASM open as a fallback). The
 * engine is also where credential binding is enforced: `ts-mls` takes an
 * `AuthenticationService`, and this class supplies one backed by
 * {@link IdentityService.verifyCredential}, so a member whose MLS signature key
 * is not vouched for by their claimed BRC-100 identity never enters a group.
 *
 * The engine holds no group state: every operation takes a serialized state in
 * and hands the advanced state back. Private KeyPackage material is a
 * parameter, never a field — the library retains none of it.
 */
export class MlsEngine {
  readonly ciphersuite: MlsCiphersuiteName

  constructor(private readonly options: MlsEngineOptions) {
    this.ciphersuite = options.ciphersuite ?? DEFAULT_CIPHERSUITE
  }

  get identity(): IdentityService {
    return this.options.identity
  }

  /**
   * Mint a KeyPackage bound to this wallet's identity.
   *
   * The private half is returned and immediately forgotten — storing it is the
   * caller's job and the library's prohibition.
   */
  async createKeyPackage(options: KeyPackageOptions = {}): Promise<MintedKeyPackage> {
    const ciphersuite = options.ciphersuite ?? this.ciphersuite
    const suite = await resolveCiphersuite(ciphersuite)

    const signatureKeyPair = await suite.signature.keygen()
    const { credential, keyId } = await this.identity.createCredential({
      ciphersuite,
      mlsSignaturePublicKey: signatureKeyPair.publicKey
    })

    const notBefore = BigInt(Math.floor(Date.now() / 1000))
    const lifetime = {
      notBefore,
      notAfter: notBefore + BigInt(options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS)
    }

    const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: credential },
      capabilitiesFor(),
      lifetime,
      [],
      signatureKeyPair,
      suite
    )

    return {
      ref: toHex(await makeKeyPackageRef(publicPackage, suite.hash)),
      keyPackage: asKeyPackageBytes(encodeKeyPackage(publicPackage)),
      privateKeyPackage: encodePrivateKeyPackage(privatePackage),
      keyId,
      ciphersuite,
      lifetime
    }
  }

  /**
   * Create a group containing only this client, at epoch 0.
   *
   * The private KeyPackage is used and dropped; the returned state is the only
   * thing worth keeping.
   */
  async createGroup(input: {
    keyPackage: KeyPackageBytes
    privateKeyPackage: PrivateKeyPackageBytes
  }): Promise<{ mlsGroupId: MlsGroupId; state: Uint8Array }> {
    const suite = await resolveCiphersuite(this.ciphersuite)
    const groupId = suite.rng.randomBytes(GROUP_ID_BYTES)

    const state = await mlsCreateGroup(
      groupId,
      parseKeyPackage(input.keyPackage, this.ciphersuite),
      decodePrivateKeyPackage(input.privateKeyPackage),
      [],
      suite,
      clientConfigFor(this.ciphersuite)
    )
    return { mlsGroupId: toHex(groupId), state: encodeState(state) }
  }

  /**
   * Add members and commit, producing one Commit for the existing group and one
   * Welcome covering every newcomer.
   *
   * The Welcome carries the ratchet tree inline: a newcomer has no other source
   * for it, and the transport delivers one blob.
   */
  async addMembers(input: {
    state: Uint8Array
    keyPackages: KeyPackageBytes[]
  }): Promise<{ state: Uint8Array; commit: Uint8Array; welcome: Uint8Array }> {
    if (input.keyPackages.length === 0) {
      throw new GroupMessagingError('addMembers needs at least one KeyPackage')
    }
    const suite = await resolveCiphersuite(this.ciphersuite)
    const proposals: Proposal[] = input.keyPackages.map(bytes => ({
      proposalType: 'add',
      add: { keyPackage: parseKeyPackage(bytes, this.ciphersuite) }
    }))

    const result = await createCommit(
      {
        state: decodeState(input.state, this.ciphersuite),
        cipherSuite: suite,
        pskIndex: emptyPskIndex
      },
      { ...COMMIT_OPTIONS, extraProposals: proposals }
    )
    if (result.welcome === undefined) {
      throw new GroupMessagingError('Commit produced no Welcome for the added members')
    }
    return {
      state: encodeState(result.newState),
      commit: encodeMlsMessage(result.commit),
      welcome: encodeWelcome(result.welcome)
    }
  }

  /**
   * Remove members by identity and commit.
   *
   * MLS removes by leaf index, and the mapping comes from the ratchet tree's
   * own numbering: a filtered roster renumbers everyone after a blank leaf and
   * would remove the wrong member.
   */
  async removeMembers(input: {
    state: Uint8Array
    identityKeys: IdentityKey[]
  }): Promise<{ state: Uint8Array; commit: Uint8Array }> {
    if (input.identityKeys.length === 0) {
      throw new GroupMessagingError('removeMembers needs at least one identity')
    }
    const suite = await resolveCiphersuite(this.ciphersuite)
    const state = decodeState(input.state, this.ciphersuite)
    const members = membersOf(state.ratchetTree)

    const proposals: Proposal[] = input.identityKeys.map(identityKey => {
      const member = members.find(candidate => candidate.identityKey === identityKey)
      if (member === undefined) {
        throw new GroupMessagingError(`${identityKey} is not a member of this group`)
      }
      return { proposalType: 'remove', remove: { removed: member.leafIndex } }
    })

    const result = await createCommit(
      { state, cipherSuite: suite, pskIndex: emptyPskIndex },
      { ...COMMIT_OPTIONS, extraProposals: proposals }
    )
    return { state: encodeState(result.newState), commit: encodeMlsMessage(result.commit) }
  }

  /**
   * Rotate this client's leaf key, for post-compromise security.
   *
   * An empty commit still carries a fresh UpdatePath, so the roster is
   * unchanged but every secret derived from this leaf is replaced.
   */
  async update(input: { state: Uint8Array }): Promise<{ state: Uint8Array; commit: Uint8Array }> {
    const suite = await resolveCiphersuite(this.ciphersuite)
    const result = await createCommit(
      {
        state: decodeState(input.state, this.ciphersuite),
        cipherSuite: suite,
        pskIndex: emptyPskIndex
      },
      { ...COMMIT_OPTIONS }
    )
    return { state: encodeState(result.newState), commit: encodeMlsMessage(result.commit) }
  }

  /**
   * Join the group a Welcome invites this client into.
   *
   * The KeyPackage pair must be the one whose public half the committer added;
   * any other pair cannot decrypt the Welcome's group secrets.
   */
  async joinFromWelcome(input: {
    welcome: Uint8Array
    keyPackage: KeyPackageBytes
    privateKeyPackage: PrivateKeyPackageBytes
  }): Promise<{ mlsGroupId: MlsGroupId; state: Uint8Array }> {
    const welcome = decodeExactly(decodeWelcome, input.welcome, 'Welcome')
    if (welcome.cipherSuite !== this.ciphersuite) {
      throw new GroupMessagingError(
        `Welcome is for ciphersuite ${welcome.cipherSuite}, this client uses ${this.ciphersuite}`
      )
    }
    const suite = await resolveCiphersuite(this.ciphersuite)

    const state = await joinGroup(
      welcome,
      parseKeyPackage(input.keyPackage, this.ciphersuite),
      decodePrivateKeyPackage(input.privateKeyPackage),
      emptyPskIndex,
      suite,
      undefined,
      undefined,
      clientConfigFor(this.ciphersuite)
    )
    return {
      mlsGroupId: toHex(state.groupContext.groupId),
      state: encodeState(state)
    }
  }

  /**
   * Encrypt application data for the group.
   *
   * The returned state must be kept: the message ratchet advanced, and reusing
   * the old state would reuse a nonce.
   */
  async encrypt(input: {
    state: Uint8Array
    plaintext: Uint8Array
  }): Promise<{ state: Uint8Array; message: Uint8Array }> {
    const suite = await resolveCiphersuite(this.ciphersuite)
    const result = await createApplicationMessage(
      decodeState(input.state, this.ciphersuite),
      input.plaintext,
      suite
    )
    return {
      state: encodeState(result.newState),
      message: encodeMlsMessage({
        version: 'mls10',
        wireformat: 'mls_private_message',
        privateMessage: result.privateMessage
      })
    }
  }

  /**
   * Route one inbound MLS message.
   *
   * Membership changes are reported by diffing the roster across the commit,
   * which is cheaper than reconstructing the proposals and correct regardless
   * of how they were bundled. The sender of an application message is not
   * diffed but read from its sender data — see {@link senderOf}.
   */
  async process(input: { state: Uint8Array; message: Uint8Array }): Promise<MlsProcessResult> {
    const suite = await resolveCiphersuite(this.ciphersuite)
    const before = decodeState(input.state, this.ciphersuite)
    const message = decodeExactly(decodeMlsMessage, input.message, 'MLS message')

    if (
      message.wireformat !== 'mls_private_message' &&
      message.wireformat !== 'mls_public_message'
    ) {
      throw new GroupMessagingError(`Unexpected wire format ${message.wireformat}`)
    }

    const result = await processMessage(message, before, emptyPskIndex, acceptAll, suite)
    if (result.kind === 'applicationMessage') {
      // Application data only ever travels in a private message; the check is
      // what lets the type system see that.
      if (message.wireformat !== 'mls_private_message') {
        throw new GroupMessagingError('Application data arrived in a public message')
      }
      return {
        kind: 'application',
        state: encodeState(result.newState),
        sender: await senderOf(before, message.privateMessage, suite),
        epoch: message.privateMessage.epoch,
        plaintext: result.message
      }
    }

    const wasCommit = result.newState.groupContext.epoch > before.groupContext.epoch
    if (!wasCommit) return { kind: 'proposal', state: encodeState(result.newState) }

    const previous = membersOf(before.ratchetTree).map(member => member.identityKey)
    const current = membersOf(result.newState.ratchetTree).map(member => member.identityKey)
    return {
      kind: 'commit',
      state: encodeState(result.newState),
      added: current.filter(identity => !previous.includes(identity)),
      removed: previous.filter(identity => !current.includes(identity))
    }
  }

  /**
   * Read the group and epoch a message belongs to without decrypting it.
   *
   * `PrivateMessage` carries both in cleartext framing, which is what lets the
   * client queue a message for an epoch it has not reached yet. Anything that
   * is not a well-formed private message reports nothing rather than throwing.
   * The decode is guarded because `decodeMlsMessage` does not merely return
   * `undefined` on bad input: a frame that starts out plausible and then runs
   * short makes it throw, and a truncated frame off a lossy transport is
   * exactly what this method exists to triage.
   */
  epochOf(message: Uint8Array): { mlsGroupId: MlsGroupId; epoch: bigint } | undefined {
    let decoded: ReturnType<typeof decodeMlsMessage>
    try {
      decoded = decodeMlsMessage(message, 0)
    } catch {
      return undefined
    }
    if (decoded === undefined) return undefined
    const [value, consumed] = decoded
    if (consumed !== message.length) return undefined
    if (value.wireformat !== 'mls_private_message') return undefined
    return {
      mlsGroupId: toHex(value.privateMessage.groupId),
      epoch: value.privateMessage.epoch
    }
  }

  /**
   * The BRC-100 identity a KeyPackage's credential claims.
   *
   * Used to address a Welcome, which is the one moment the client has a
   * KeyPackage and no group to read a roster from. The claim is not verified
   * here — `addMembers` puts every added KeyPackage through the authentication
   * service before a Welcome exists, and the Welcome is encrypted to the
   * KeyPackage's own init key regardless of where it is sent.
   */
  identityForKeyPackage(keyPackage: KeyPackageBytes): IdentityKey {
    const parsed = parseKeyPackage(keyPackage, this.ciphersuite)
    if (parsed.leafNode.credential.credentialType !== 'basic') {
      throw new GroupMessagingError('KeyPackage carries a non-basic credential')
    }
    return decodeCredentialIdentity(parsed.leafNode.credential.identity).identityKey
  }

  /**
   * Every KeyPackage ref a Welcome carries secrets for, in wire order.
   *
   * One Welcome covers every member added by a single Commit, so the recipient
   * has to pick out its own: the client intersects these with the refs it has
   * stored. All of them are hashes — nothing secret leaves this call.
   */
  refsForWelcome(welcome: Uint8Array): KeyPackageRef[] {
    const decoded = decodeExactly(decodeWelcome, welcome, 'Welcome')
    return decoded.secrets.map(secret => toHex(secret.newMember))
  }

  /**
   * Which of `candidates` is the public half of `privateKeyPackage`.
   *
   * The private blob holds no public key, and deriving one would mean this
   * file knowing which curve each suite sits on. Instead the private signature
   * key signs a probe and each candidate's leaf signature key is asked to
   * verify it — one operation the `Signature` interface already exposes for
   * every suite. Candidates minted for a different ciphersuite are skipped, not
   * fatal. Returns `undefined` when none match.
   */
  async matchKeyPackage(input: {
    privateKeyPackage: PrivateKeyPackageBytes
    candidates: KeyPackageBytes[]
  }): Promise<KeyPackageBytes | undefined> {
    if (input.candidates.length === 0) return undefined
    const suite = await resolveCiphersuite(this.ciphersuite)
    const { signaturePrivateKey } = decodePrivateKeyPackage(input.privateKeyPackage)
    const probe = suite.rng.randomBytes(32)
    const signature = await suite.signature.sign(signaturePrivateKey, probe)

    for (const candidate of input.candidates) {
      // A KeyPackage minted for the other supported suite is a normal thing to
      // have stored — `createKeyPackage` takes a ciphersuite, and answering an
      // invitation that asks for one is the intended use. It simply cannot be
      // this private half's public twin, so skip it rather than letting
      // `parseKeyPackage` fail the whole search on somebody else's suite.
      let parsed: KeyPackage
      try {
        parsed = parseKeyPackage(candidate, this.ciphersuite)
      } catch {
        continue
      }
      const matches = await suite.signature.verify(
        parsed.leafNode.signaturePublicKey,
        probe,
        signature
      )
      if (matches) return candidate
    }
    return undefined
  }

  /** Read a group's identifier, epoch and roster out of its stored state. */
  async info(state: Uint8Array): Promise<MlsGroupSummary> {
    const decoded = decodeState(state, this.ciphersuite)
    return {
      mlsGroupId: toHex(decoded.groupContext.groupId),
      epoch: decoded.groupContext.epoch,
      members: membersOf(decoded.ratchetTree)
    }
  }

  /**
   * A KeyPackage as plain data: exactly what the bytes say, and no verdicts.
   *
   * Decoding and judging are separate jobs, and mixing them produced a
   * structure where a reader could not tell which fields came off the wire and
   * which were our own conclusions. {@link verifyKeyPackage} answers the
   * "is it valid" questions; this one answers "what is in it".
   *
   * Never throws — a UI has to render whatever arrived off the wire, so
   * malformed input, including a ciphersuite this build cannot resolve, comes
   * back as an `error` field instead.
   */
  async describeKeyPackage(bytes: KeyPackageBytes): Promise<KeyPackageDescription> {
    let keyPackage: KeyPackage
    try {
      keyPackage = decodeExactly(decodeKeyPackage, bytes, 'KeyPackage')
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }

    try {
      const ciphersuite = keyPackage.cipherSuite as MlsCiphersuiteName
      const suite = await resolveCiphersuite(ciphersuite)
      const leaf = keyPackage.leafNode

      const identity =
        leaf.credential.credentialType === 'basic' ? leaf.credential.identity : undefined

      let credentialFields: {
        version?: number
        identityKey?: IdentityKey
        keyId?: string
        signature?: string
      } = {}
      if (identity !== undefined) {
        try {
          const parsed = decodeCredentialIdentity(identity)
          credentialFields = {
            version: parsed.version,
            identityKey: parsed.identityKey,
            keyId: parsed.keyId,
            signature: toHex(parsed.signature)
          }
        } catch {
          // Not our credential format. The raw identity field is still reported.
        }
      }

      return {
        ref: toHex(await makeKeyPackageRef(keyPackage, suite.hash)),
        ciphersuite,
        initKey: toHex(keyPackage.initKey),
        signature: toHex(keyPackage.signature),
        leafNode: {
          signaturePublicKey: toHex(leaf.signaturePublicKey),
          encryptionKey: toHex(leaf.hpkePublicKey),
          signature: toHex(leaf.signature),
          leafNodeSource: leaf.leafNodeSource,
          credential: {
            type: leaf.credential.credentialType,
            identity: identity === undefined ? '' : toHex(identity),
            ...credentialFields
          },
          capabilities: {
            ciphersuites: [...leaf.capabilities.ciphersuites],
            credentials: [...leaf.capabilities.credentials]
          },
          lifetime: {
            notBefore: describeLifetimeBound(leaf.lifetime.notBefore),
            notAfter: describeLifetimeBound(leaf.lifetime.notAfter)
          }
        }
      }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  /**
   * Run every check a KeyPackage can be put through, and report each verdict
   * separately.
   *
   * Separate because they fail independently and mean different things: see
   * {@link KeyPackageVerification}. Callers outside this package cannot run the
   * two MLS checks themselves — `ts-mls` is walled off behind this file — which
   * is why they are offered here rather than left to the caller.
   *
   * Never throws, for the same reason {@link describeKeyPackage} does not.
   */
  async verifyKeyPackage(bytes: KeyPackageBytes): Promise<KeyPackageVerification> {
    const failed = { credentialBinding: false, leafSignature: false, keyPackageSignature: false }
    let keyPackage: KeyPackage
    try {
      keyPackage = decodeExactly(decodeKeyPackage, bytes, 'KeyPackage')
    } catch (cause) {
      return { ...failed, error: cause instanceof Error ? cause.message : String(cause) }
    }

    // Held outside the try so every return below can name it: it is the fact
    // that explains a verdict, and the error paths are where it is needed most.
    const declaredCiphersuite = keyPackage.cipherSuite

    try {
      // The signatures are checked under the suite the artifact was built with,
      // because that is what they were made with. The credential is not: its
      // preimage is domain-separated by suite name, so reading that name out of
      // the credential would let it pick its own authority.
      // Checked against the list rather than inferred from a failed build: a
      // supported suite can fail to resolve for reasons of its own — an absent
      // optional backend, no `crypto.subtle` outside a secure context — and
      // calling that "unsupported" would be a confident wrong answer. It also
      // keeps an attacker-chosen name out of the codec entirely.
      if (!(SUPPORTED_CIPHERSUITES as readonly string[]).includes(declaredCiphersuite)) {
        return {
          ...failed,
          declaredCiphersuite,
          error: `Unsupported ciphersuite ${String(declaredCiphersuite)}`
        }
      }
      const suite = await resolveCiphersuite(declaredCiphersuite as MlsCiphersuiteName)
      const leaf = keyPackage.leafNode

      let credentialBinding = false
      if (leaf.credential.credentialType === 'basic') {
        try {
          IdentityService.verifyCredential(
            leaf.credential.identity,
            leaf.signaturePublicKey,
            this.ciphersuite
          )
          credentialBinding = true
        } catch {
          credentialBinding = false
        }
      }

      const [keyPackageSignature, leafSignature] = await Promise.all([
        verifyKeyPackage(keyPackage, suite.signature).catch(() => false),
        leaf.leafNodeSource === 'key_package'
          ? verifyLeafNodeSignatureKeyPackage(leaf, suite.signature).catch(() => false)
          : Promise.resolve(false)
      ])

      return { credentialBinding, leafSignature, keyPackageSignature, declaredCiphersuite }
    } catch (cause) {
      return {
        ...failed,
        declaredCiphersuite,
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }
}
