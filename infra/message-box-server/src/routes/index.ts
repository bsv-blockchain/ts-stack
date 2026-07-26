import sendMessage from './sendMessage.js'
import listMessages from './listMessages.js'
import acknowledgeMessage from './acknowledgeMessage.js'
import registerDevice from './registerDevice.js'
import listDevices from './listDevices.js'
import { permissionRoutes } from './permissions/index.js'
import { healthRoute, readinessRoute } from './health.js'

// Explicitly type the exported arrays to avoid type inference issues
export const preAuth: Array<{ type: string; path: string; func: Function }> = [
  healthRoute,
  readinessRoute
]
export const postAuth: Array<{ type: string; path: string; func: Function }> = [
  sendMessage,
  listMessages,
  acknowledgeMessage,
  registerDevice,
  listDevices,
  ...permissionRoutes
]
