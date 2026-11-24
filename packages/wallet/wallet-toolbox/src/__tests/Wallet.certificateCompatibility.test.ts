import { once } from 'node:events'
import { StorageServer } from '../storage/remoting/StorageServer'
import type { Wallet } from '../Wallet'
import {
  Certificate,
  VerifiableCertificate,
  MasterCertificate,
  PrivateKey,
  ProtoWallet,
  Utils,
  WalletClient,
  WalletWireProcessor,
  WalletWireTransceiver
} from '@bsv/sdk'
import { _tu } from '../../test/utils/TestUtilsWalletStorage'

// Stored historical records need not be reacquired or rewritten to be listed/proven/retired.
describe('existing certificate compatibility through wallet and storage', () => {
  jest.setTimeout(30000)
  test.each([1, 16, 39, 128])('%i-byte stored types use the existing BRC-100 APIs', async length => {
    const { wallet, storage, activeStorage, userId, rootKey } = await _tu.createSQLiteTestWallet({
      databaseName: `legacyCertificateCompatibility${length}`,
      dropAll: true
    })
    let remoteWallet: Wallet | undefined
    let server: StorageServer | undefined
    try {
      const certifierWallet = new ProtoWallet(new PrivateKey(7))
      const certifier = (await certifierWallet.getPublicKey({ identityKey: true })).publicKey
      const { certificateFields, masterKeyring } = await MasterCertificate.createCertificateFields(
        certifierWallet,
        wallet.identityKey,
        { name: 'Alice' }
      )
      const type = Utils.toBase64(Array.from({ length: length }, () => 3))
      const serialNumber = Utils.toBase64(Array.from({ length: 32 }, () => 2))
      const now = new Date()
      // Reproduce the historical preimage independently: original type bytes,
      // followed by the unchanged canonical serializer's remaining fields.
      const canonical = new Certificate(
        Utils.toBase64(Array.from({ length: 32 }, () => 3)),
        serialNumber,
        wallet.identityKey,
        certifier,
        '00'.repeat(32) + '.0',
        certificateFields
      )
      const preimage = [...Utils.toArray(type, 'base64'), ...canonical.toBinary(false).slice(32)]
      const signed = await certifierWallet.createSignature({
        protocolID: [2, 'certificate signature'],
        keyID: `${type} ${serialNumber}`,
        data: preimage
      })
      const row = {
        certificateId: 0,
        userId,
        created_at: now,
        updated_at: now,
        type,
        serialNumber,
        subject: wallet.identityKey,
        certifier,
        revocationOutpoint: '00'.repeat(32) + '.0',
        signature: Utils.toHex(signed.signature),
        isDeleted: false
      }
      const certificateId = await activeStorage.insertCertificate(row)
      await activeStorage.insertCertificateField({
        certificateId,
        userId,
        created_at: now,
        updated_at: now,
        fieldName: 'name',
        fieldValue: certificateFields.name,
        masterKey: masterKeyring.name
      })
      let activeWallet = wallet
      if (length === 39) {
        // Exercise the separate authenticated storage JSON-RPC boundary on an
        // ephemeral loopback port. Neither magic marker nor phantom field reaches it.
        server = new StorageServer(activeStorage, { port: 0, host: '127.0.0.1', wallet, monetize: false })
        server.start()
        await once(server.server, 'listening')
        const port = server.server.address().port
        const remote = await _tu.createTestWalletWithStorageClient({
          rootKeyHex: rootKey.toHex(),
          endpointUrl: `http://127.0.0.1:${port}`
        })
        remoteWallet = remote.wallet
        activeWallet = remote.wallet
      }
      const client = new WalletClient(new WalletWireTransceiver(new WalletWireProcessor(activeWallet)), 'example.com')
      const unfiltered = await client.listCertificates({ certifiers: [], types: [] })
      expect(unfiltered.certificates).toHaveLength(1)
      expect(unfiltered.certificates[0]).toMatchObject({ type, serialNumber, fields: certificateFields })
      const listed = await client.listCertificates({ certifiers: [certifier], types: [type] })
      expect(listed.certificates).toHaveLength(1)
      expect(listed.totalCertificates).toBe(1)
      await expect(Certificate.fromObject(listed.certificates[0]).verify()).resolves.toBe(true)
      const verifierWallet = new ProtoWallet(new PrivateKey(11))
      const verifier = (await verifierWallet.getPublicKey({ identityKey: true })).publicKey
      const proof = await client.proveCertificate({
        certificate: listed.certificates[0],
        verifier,
        fieldsToReveal: ['name']
      })
      expect(
        await VerifiableCertificate.fromCertificate(
          { ...row, fields: certificateFields },
          proof.keyringForVerifier
        ).decryptFields(verifierWallet)
      ).toEqual({ name: 'Alice' })
      await expect(
        client.acquireCertificate({
          ...row,
          fields: certificateFields,
          acquisitionProtocol: 'direct',
          keyringRevealer: 'certifier',
          keyringForSubject: masterKeyring
        })
      ).rejects.toThrow()
      await expect(client.relinquishCertificate({ type, serialNumber, certifier })).resolves.toEqual({
        relinquished: true
      })
      const stored = await activeStorage.findCertificates({ partial: { certificateId, userId } })
      expect(stored[0]).toMatchObject({ type, signature: row.signature, isDeleted: true })
      expect((await client.listCertificates({ certifiers: [], types: [] })).certificates).toHaveLength(0)
    } finally {
      if (remoteWallet !== undefined) await remoteWallet.destroy()
      if (server !== undefined) {
        server.server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server!.server.close((error?: Error) => (error === undefined ? resolve() : reject(error)))
        )
      }
      await storage.destroy()
    }
  })
})
