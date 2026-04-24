import { initializeApp, getApps, getApp, cert, applicationDefault, type App } from 'firebase-admin/app'
import { getMessaging, type Messaging, type Message } from 'firebase-admin/messaging'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import * as path from 'path'
import dotenv from 'dotenv'

dotenv.config()

let firebaseApp: App | null = null

/**
 * Initialize Firebase Admin SDK.
 * Returns null (and logs a warning) when ENABLE_FIREBASE is not 'true',
 * or when FIREBASE_PROJECT_ID is absent, so the server can run without Firebase.
 */
export function initializeFirebase(): App | null {
  const enableFirebase = process.env.ENABLE_FIREBASE

  if (enableFirebase !== 'true') {
    console.log(`Firebase is disabled (ENABLE_FIREBASE=${enableFirebase ?? 'unset'}). Skipping initialization.`)
    return null
  }

  if (firebaseApp != null) {
    console.log('Firebase already initialized')
    return firebaseApp
  }

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    const projectId = process.env.FIREBASE_PROJECT_ID

    if (projectId == null || projectId === '') {
      throw new Error('FIREBASE_PROJECT_ID environment variable is required')
    }

    let firebaseCredential: any // Will be assigned based on auth method

    if (serviceAccountJson != null && serviceAccountJson !== '') {
      console.log('Using Firebase service account from environment variable')
      try {
        console.log('Service account JSON length:', serviceAccountJson.length)
        console.log('First 100 chars:', serviceAccountJson.substring(0, 100))

        // Debug credential functions
        console.log('cert function:', typeof cert)
        console.log('applicationDefault function:', typeof applicationDefault)

        const serviceAccount = JSON.parse(serviceAccountJson)
        console.log('Parsed service account keys:', Object.keys(serviceAccount ?? {}))

        if (serviceAccount == null || typeof serviceAccount !== 'object') {
          throw new Error('Parsed service account is not a valid object')
        }

        if (serviceAccount.private_key == null || serviceAccount.client_email == null || serviceAccount.project_id == null) {
          throw new Error('Service account missing required fields (private_key, client_email, project_id)')
        }

        firebaseCredential = cert(serviceAccount)
        console.log('✅ Firebase credential created successfully')
      } catch (parseError) {
        console.error('❌ Firebase service account parsing failed:', parseError)
        throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ${(parseError instanceof Error) ? parseError.message : 'Invalid JSON'}`)
      }
    } else if (serviceAccountPath != null && serviceAccountPath !== '') {
      console.log('Using Firebase service account key file')
      const absolutePath = path.resolve(process.cwd(), serviceAccountPath)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      firebaseCredential = cert(require(absolutePath))
    } else {
      console.log('Using Firebase default credentials')
      firebaseCredential = applicationDefault()
    }

    // Check if Firebase app is already initialized
    if (getApps().length === 0) {
      firebaseApp = initializeApp({
        credential: firebaseCredential,
        projectId
      })
    } else {
      firebaseApp = getApp()
    }

    console.log('✅ Firebase Admin SDK initialized successfully')
    return firebaseApp
  } catch (error) {
    console.error('❌ Firebase initialization failed:', error)
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
    throw new Error(
      'Firebase not initialized. Call initializeFirebase() first.'
    )
  }
  return getFirestore(firebaseApp)
}

interface FCMPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: number;
  data?: Record<string, string>;
}

interface SendNotificationResult {
  success: boolean;
  messageId: string;
}

/**
 * Send a push notification via FCM
 */
export async function sendNotification(
  fcmToken: string,
  payload: FCMPayload,
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
        ...(payload.icon && { imageUrl: payload.icon }),
      },
      data: payload.data || {},
      android: {
        priority: "high",
        notification: {
          clickAction: "OPEN_ACTIVITY_1",
          ...(payload.badge && { notificationCount: payload.badge }),
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: "default",
            badge: payload.badge || 1,
          },
        },
      },
    };

    const response = await messaging.send(message);
    console.log("✅ Notification sent successfully:", response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error("❌ Failed to send notification:", error);
    throw error;
  }
}
