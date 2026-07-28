import {
  initializeApp,
  getApps,
  getApp,
  cert,
  applicationDefault,
  type App,
  type Credential
} from 'firebase-admin/app'
import { getMessaging, type Messaging, type Message } from 'firebase-admin/messaging'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import dotenv from 'dotenv'
import { log } from '../utils/logger.js'

dotenv.config()

let firebaseApp: App | null = null

function credentialFromJson(rawCredential: string, source: string): Credential {
  try {
    const serviceAccount: unknown = JSON.parse(rawCredential)
    if (serviceAccount == null || typeof serviceAccount !== 'object') {
      throw new TypeError('Parsed service account is not a valid object')
    }
    const values = serviceAccount as Record<string, unknown>
    for (const field of ['private_key', 'client_email', 'project_id']) {
      if (typeof values[field] !== 'string' || values[field] === '') {
        throw new TypeError(
          'Service account missing required fields (private_key, client_email, project_id)'
        )
      }
    }
    return cert({
      privateKey: values.private_key as string,
      clientEmail: values.client_email as string,
      projectId: values.project_id as string
    })
  } catch (error) {
    throw new TypeError(
      `Failed to parse Firebase service account from ${source}: ${error instanceof Error ? error.message : 'Invalid JSON'}`,
      { cause: error }
    )
  }
}

function resolveFirebaseCredential(): Credential {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (serviceAccountJson != null && serviceAccountJson !== '') {
    log.info(
      { operation: 'firebase.init', credential_source: 'env' },
      'Using Firebase service account from environment variable'
    )
    return credentialFromJson(serviceAccountJson, 'FIREBASE_SERVICE_ACCOUNT_JSON')
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  if (serviceAccountPath != null && serviceAccountPath !== '') {
    log.info(
      { operation: 'firebase.init', credential_source: 'file' },
      'Using Firebase service account key file'
    )
    const absolutePath = path.resolve(process.cwd(), serviceAccountPath)
    return credentialFromJson(readFileSync(absolutePath, 'utf8'), absolutePath)
  }

  log.info(
    { operation: 'firebase.init', credential_source: 'default' },
    'Using Firebase default credentials'
  )
  return applicationDefault()
}

/**
 * Initialize Firebase Admin SDK.
 * Returns null (and logs a warning) when ENABLE_FIREBASE is not 'true',
 * or when FIREBASE_PROJECT_ID is absent, so the server can run without Firebase.
 */
export function initializeFirebase(): App | null {
  const enableFirebase = process.env.ENABLE_FIREBASE

  if (enableFirebase !== 'true') {
    log.info(
      { operation: 'firebase.init', enable_firebase: enableFirebase ?? 'unset' },
      'Firebase disabled, skipping initialization'
    )
    return null
  }

  if (firebaseApp != null) {
    log.info({ operation: 'firebase.init' }, 'Firebase already initialized')
    return firebaseApp
  }

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID

    if (projectId == null || projectId === '') {
      throw new TypeError('FIREBASE_PROJECT_ID environment variable is required')
    }

    const firebaseCredential = resolveFirebaseCredential()

    // Check if Firebase app is already initialized
    if (getApps().length === 0) {
      firebaseApp = initializeApp({
        credential: firebaseCredential,
        projectId
      })
    } else {
      firebaseApp = getApp()
    }

    log.info({ operation: 'firebase.init' }, 'Firebase Admin SDK initialized successfully')
    return firebaseApp
  } catch (error) {
    log.error(
      { operation: 'firebase.init', outcome: 'error', err: error },
      'Firebase initialization failed'
    )
    throw error
  }
}

/**
 * Get Firebase Messaging instance, or null if Firebase is not initialized.
 */
export function getFirebaseMessaging(): Messaging | null {
  if (firebaseApp == null) {
    return null
  }
  return getMessaging(firebaseApp)
}

/**
 * Get Firestore instance  
 */
export function getFirebaseFirestore(): Firestore {
  if (firebaseApp == null) {
    throw new Error('Firebase not initialized. Call initializeFirebase() first.')
  }
  return getFirestore(firebaseApp)
}

interface FCMPayload {
  title: string
  body: string
  icon?: string
  badge?: number
  data?: Record<string, string>
}

interface SendNotificationResult {
  success: boolean
  messageId: string
}

/**
 * Send a push notification via FCM
 */
export async function sendNotification(
  fcmToken: string,
  payload: FCMPayload
): Promise<SendNotificationResult> {
  try {
    const messaging = getFirebaseMessaging()

    if (messaging == null) {
      throw new Error('Firebase Messaging is not initialized (ENABLE_FIREBASE != true)')
    }

    const message: Message = {
      token: fcmToken,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.icon && { imageUrl: payload.icon })
      },
      data: payload.data || {},
      android: {
        priority: 'high',
        notification: {
          clickAction: 'OPEN_ACTIVITY_1',
          ...(payload.badge && { notificationCount: payload.badge })
        }
      },
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body
            },
            sound: 'default',
            badge: payload.badge || 1
          }
        }
      }
    }

    const response = await messaging.send(message)
    log.info(
      { operation: 'firebase.send_notification', message_id: response },
      'Notification sent successfully'
    )
    return { success: true, messageId: response }
  } catch (error) {
    log.error(
      { operation: 'firebase.send_notification', outcome: 'error', err: error },
      'Failed to send notification'
    )
    throw error
  }
}
