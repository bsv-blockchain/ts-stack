export default `
# User Management Protocol Topic Manager Docs

To have outputs accepted into the Meter overlay network, use the Meter sCrypt contract to create valid locking scripts.

Submit transactions that start new meters at 1, or spend existing meters already submitted.

The latest state of all meters will be tracked, and will be available through the corresponding Meter Lookup Service.

[UMPTokenInteractor](https://github.com/bsv-blockchain/wallet-toolbox/blob/579f31482672daf6544c10fd0233e16ac61381d4/src/CWIStyleWalletManager.ts#L233)

\`\`\`typescript
public async buildAndSend(
    wallet: WalletInterface, // This wallet MUST be the one built for the default profile
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    token: UMPToken,
    oldTokenToConsume?: UMPToken
  ): Promise<OutpointString> {
    // 1) Construct the data fields for the new UMP token.
    const fields: number[][] = []

    fields[0] = token.passwordSalt
    fields[1] = token.passwordPresentationPrimary
    fields[2] = token.passwordRecoveryPrimary
    fields[3] = token.presentationRecoveryPrimary
    fields[4] = token.passwordPrimaryPrivileged
    fields[5] = token.presentationRecoveryPrivileged
    fields[6] = token.presentationHash
    fields[7] = token.recoveryHash
    fields[8] = token.presentationKeyEncrypted
    fields[9] = token.passwordKeyEncrypted
    fields[10] = token.recoveryKeyEncrypted

    // Optional field (11) for encrypted profiles
    if (token.profilesEncrypted) {
      fields[11] = token.profilesEncrypted
    }

    // 2) Create a PushDrop script referencing these fields, locked with the admin key.
    const script = await new PushDrop(wallet, adminOriginator).lock(
      fields,
      [2, 'admin user management token'], // protocolID
      '1', // keyID
      'self', // counterparty
      /*forSelf=*/ true,
      /*includeSignature=*/ true
    )

    // 3) Prepare the createAction call. If oldTokenToConsume is provided, gather the outpoint.
    const inputs: CreateActionInput[] = []
    let inputToken: { beef: number[]; outputIndex: number } | undefined
    if (oldTokenToConsume?.currentOutpoint) {
      inputToken = await this.findByOutpoint(oldTokenToConsume.currentOutpoint)
      // If there is no token on the overlay, we can't consume it. Just start over with a new token.
      if (!inputToken) {
        oldTokenToConsume = undefined

        // Otherwise, add the input
      } else {
        inputs.push({
          outpoint: oldTokenToConsume.currentOutpoint,
          unlockingScriptLength: 73, // typical signature length
          inputDescription: 'Consume old UMP token'
        })
      }
    }

    const outputs = [
      {
        lockingScript: script.toHex(),
        satoshis: 1,
        outputDescription: 'New UMP token output'
      }
    ]

    // 4) Build the partial transaction via createAction.
    let createResult
    try {
      createResult = await wallet.createAction(
        {
          description: oldTokenToConsume ? 'Renew UMP token (consume old, create new)' : 'Create new UMP token',
          inputs,
          outputs,
          inputBEEF: inputToken?.beef,
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
          }
        },
        adminOriginator
      )
    } catch (e) {
      console.error('Error with UMP token update. Attempting a last-ditch effort to get a new one', e)
      createResult = await wallet.createAction(
        {
          description: 'Recover UMP token',
          outputs,
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
          }
        },
        adminOriginator
      )
    }

    // If the transaction is fully processed by the wallet
    if (!createResult.signableTransaction) {
      const finalTxid =
        createResult.txid || (createResult.tx ? Transaction.fromAtomicBEEF(createResult.tx).id('hex') : undefined)
      if (!finalTxid) {
        throw new Error('No signableTransaction and no final TX found.')
      }
      // Now broadcast to \`tm_users\` using SHIP
      const broadcastTx = Transaction.fromAtomicBEEF(createResult.tx!)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return \`\${finalTxid}.0\`
    }

    // 5) If oldTokenToConsume is present, we must sign the input referencing it.
    //    (If there's no old token, there's nothing to sign for the input.)
    let finalTxid = ''
    const reference = createResult.signableTransaction.reference
    const partialTx = Transaction.fromBEEF(createResult.signableTransaction.tx)

    if (oldTokenToConsume?.currentOutpoint) {
      // Unlock the old token with a matching PushDrop unlocker
      const unlocker = new PushDrop(wallet, adminOriginator).unlock([2, 'admin user management token'], '1', 'self')
      const unlockingScript = await unlocker.sign(partialTx, 0)

      // Provide it to the wallet
      const signResult = await wallet.signAction(
        {
          reference,
          spends: {
            0: {
              unlockingScript: unlockingScript.toHex()
            }
          }
        },
        adminOriginator
      )
      finalTxid = signResult.txid || (signResult.tx ? Transaction.fromAtomicBEEF(signResult.tx).id('hex') : '')
      if (!finalTxid) {
        throw new Error('Could not finalize transaction for renewed UMP token.')
      }
      // 6) Broadcast to \`tm_users\`
      const finalAtomicTx = signResult.tx
      if (!finalAtomicTx) {
        throw new Error('Final transaction data missing after signing renewed UMP token.')
      }
      const broadcastTx = Transaction.fromAtomicBEEF(finalAtomicTx)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return \`\${finalTxid}.0\`
    } else {
      // Fallback for creating a new token (no input spending)
      const signResult = await wallet.signAction({ reference, spends: {} }, adminOriginator)
      finalTxid = signResult.txid || (signResult.tx ? Transaction.fromAtomicBEEF(signResult.tx).id('hex') : '')
      if (!finalTxid) {
        throw new Error('Failed to finalize new UMP token transaction.')
      }
      const finalAtomicTx = signResult.tx
      if (!finalAtomicTx) {
        throw new Error('Final transaction data missing after signing new UMP token.')
      }
      const broadcastTx = Transaction.fromAtomicBEEF(finalAtomicTx)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return \`\${finalTxid}.0\`
    }
}
\`\`\`

`