import { Request, Response } from 'express'
import { Storage } from '@google-cloud/storage'
import getPriceForFile from '../utils/getPriceForFile'
import { getWallet } from '../utils/walletSingleton'
import { LockingScript, PrivateKey, PushDrop, SHIPBroadcaster, StorageUtils, TopicBroadcaster, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { getMetadata } from '../utils/getMetadata'

const storage = new Storage()
const GCP_BUCKET_NAME = process.env.GCP_BUCKET_NAME as string
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const BSV_NETWORK = process.env.BSV_NETWORK as 'mainnet' | 'testnet'

interface RenewRequest extends Request {
  auth: {
    identityKey: string
  }
  body: {
    uhrpUrl: string
    additionalMinutes: number
    limit?: number
    offset?: number
  }
}

interface RenewResponse {
  status: 'success' | 'error'
  newExpiryTime?: number
  prevExpiryTime?: number
  amount?: number
  code?: string
  description?: string
}

const renewHandler = async (req: RenewRequest, res: Response<RenewResponse>) => {
  try {
    const { identityKey } = req.auth
    if (!identityKey) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_IDENTITY_KEY',
        description: 'Missing authfetch identityKey.'
      })
    }

    const { uhrpUrl, additionalMinutes, limit, offset } = req.body
    if (!uhrpUrl || !additionalMinutes) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_FIELDS',
        description: 'Missing objectIdentifier or additionalMinutes.'
      })
    }
    if (additionalMinutes <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_TIME',
        description: 'Additional Minutes must be a positive integer'
      })
    }
    const {
      objectIdentifier,
      size,
      expiryTime: prevExpiryTime
    } = await getMetadata(uhrpUrl, identityKey, limit, offset)

    // Convert to MS to create an ISO string
    const newExpiryTimeSeconds = prevExpiryTime + (additionalMinutes * 60)
    const newCustomTimeIso = new Date(newExpiryTimeSeconds * 1000).toISOString()

    const fileSizeNum = parseInt(size, 10) || 0
    let amount = 0
    if (fileSizeNum > 0) {
      amount = await getPriceForFile({
        fileSize: fileSizeNum,
        retentionPeriod: additionalMinutes
      })
    }

    // TODO handle edge case with multiple outputs
    // Redeeming old advertisement token and replacing it with the new ones
    const wallet = await getWallet()
    const { outputs, BEEF, } = await wallet.listOutputs({
      basket: 'uhrp advertisements',
      tags: [`uhrp_url_${Utils.toHex(Utils.toArray(uhrpUrl, 'utf8'))}`, `object_identifier_${Utils.toHex(Utils.toArray(objectIdentifier, 'utf8'))}`],
      tagQueryMode: 'all',
      includeTags: true,
      include: 'entire transactions',
      limit: limit !== undefined ? limit : 200,
      offset: offset !== undefined ? offset : 0
    })

    if (!outputs || outputs.length === 0) {
      return res.status(404).json({
        status: 'error',
        code: 'ERR_OLD_ADVERTISEMENT_NOT_FOUND',
        description: `Couldn't find old advertisement output for ${uhrpUrl}`
      })
    }

    // Finding the maxpiry file with the same url
    let prevAdvertisement
    // Farthest expiration time given in seconds
    let maxpiry = 0
    for (const out of outputs) {
      if (!out.tags) continue
      const expiryTag = out.tags.find(t => t.startsWith('expiry_time_'))
      if (!expiryTag) continue

      const expiryNum = parseInt(expiryTag.substring('expiry_time_'.length), 10) || 0

      if (expiryNum > maxpiry) {
        maxpiry = expiryNum
        prevAdvertisement = out
      }
    }

    if (!prevAdvertisement || !BEEF) {
      return res.status(404).json({
        status: 'error',
        code: 'ERR_OLD_ADVERTISEMENT_NOT_FOUND',
        description: `Couldn't find old advertisement output for ${uhrpUrl}`
      })
    }

    const [prevTxid, outputIndex] = prevAdvertisement.outpoint.split('.')
    const parsedTx = Transaction.fromBEEF(BEEF, prevTxid)
    const prevLockingScript = parsedTx.outputs[Number(outputIndex)].lockingScript
    const { fields: prevFields } = PushDrop.decode(prevLockingScript)

    // Building the new action's locking script
    const fields: number[][] = [
      prevFields[0],
      prevFields[1],
      prevFields[2],
      new Utils.Writer().writeVarIntNum(newExpiryTimeSeconds).toArray(),
      prevFields[4]
    ]

    const pushdrop = new PushDrop(wallet)
    const newLockingScript = await pushdrop.lock(
      fields,
      [2, 'uhrp advertisement'],
      '1',
      'anyone',
      true
    )

    // Creating new tags
    const newTags = []
    if (prevAdvertisement.tags) {
      const uploaderTag = prevAdvertisement.tags.find(t => t.startsWith('uploader_identity_key_'))
      if (uploaderTag) newTags.push(uploaderTag)
    }
    newTags.push(`uhrp_url_${Utils.toHex(Utils.toArray(uhrpUrl, 'utf8'))}`)
    newTags.push(`object_identifier_${Utils.toHex(Utils.toArray(objectIdentifier, 'utf8'))}`)
    newTags.push(`expiry_time_${newExpiryTimeSeconds}`)

    const { signableTransaction } = await wallet.createAction({
      inputBEEF: BEEF,
      inputs: [{
        outpoint: prevAdvertisement.outpoint,
        unlockingScriptLength: 74,
        inputDescription: 'Redeeming old advertisement'
      }],
      outputs: [{
        lockingScript: newLockingScript.toHex(),
        satoshis: 1,
        basket: 'uhrp advertisements',
        outputDescription: 'UHRP advertisement token (renewed)',
        tags: newTags
      }],
      description: `Renew advertisement for uhrpUrl ${uhrpUrl}`,
      options: {
        randomizeOutputs: false
      }
    })

    if (!signableTransaction) {
      return res.status(404).json({
        status: 'error',
        code: 'ERR_CREATE_ACTION_FAILED',
        description: `Old advertisement could not be redeemed and new advertisement could not be created for uhrpUrl ${uhrpUrl}`
      })
    }

    const unlocker = pushdrop.unlock([2, 'uhrp advertisement'], '1', 'anyone')
    const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
    const unlockingScript = await unlocker.sign(partialTx, 0)
    const { tx, txid } = await wallet.signAction({
      reference: signableTransaction.reference,
      spends:
      {
        0: {
          unlockingScript: unlockingScript.toHex()
        }
      }
    })
    if (!txid || !tx) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_SIGNING_OLD_ADVERTISEMENT'
      })
    }

    const broadcaster = new SHIPBroadcaster(['tm_uhrp'], {
      networkPreset: BSV_NETWORK
    })

    await broadcaster.broadcast(Transaction.fromAtomicBEEF(tx))

    // Setting the new expiry time in the actual database
    await storage.bucket(GCP_BUCKET_NAME).file(`cdn/${objectIdentifier}`)
      .setMetadata({ customTime: newCustomTimeIso })

    return res.status(200).json({
      status: 'success',
      prevExpiryTime,
      newExpiryTime: newExpiryTimeSeconds,
      amount
    })
  } catch (error) {
    console.error('[renewHandler] error:', error)
    return res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL_RENEW',
      description: 'An error occurred while handling the renewal.'
    })
  }
}

export default {
  type: 'post',
  path: '/renew',
  summary: 'Renews storage time by adding additionalMinutes to the GCS customTime of a file found by uhrpUrl.',
  parameters: {
    uhrpUrl: 'The UHRP URL (e.g. "uhrp://somehash")',
    additionalMinutes: 'Number of minutes to extend'
  },
  exampleResponse: {
    status: 'success',
    newExpiryTime: 28921659000, // New expiry time in seconds
    prevExpiryTime: 28921599000, // Previous expiry time in seconds
    amount: 42
  },
  errors: ['ERR_MISSING_FIELDS', 'ERR_NOT_FOUND', 'ERR_INTERNAL_RENEW'],
  func: renewHandler
}
