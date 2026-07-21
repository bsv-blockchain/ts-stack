import type { MessageBoxContext } from '../context.js'
import { createSendMessageRoute } from './sendMessage.js'
import { createListMessagesRoute } from './listMessages.js'
import { createAcknowledgeMessageRoute } from './acknowledgeMessage.js'
import { createRegisterDeviceRoute } from './registerDevice.js'
import { createListDevicesRoute } from './listDevices.js'
import { createPermissionRoutes } from './permissions/index.js'

export type MessageBoxRoute = {
  type: string
  path: string
  func: Function
  knex?: unknown
}

export function createPreAuthRoutes (_ctx: MessageBoxContext): MessageBoxRoute[] {
  return []
}

export function createPostAuthRoutes (ctx: MessageBoxContext): MessageBoxRoute[] {
  return [
    createSendMessageRoute(ctx),
    createListMessagesRoute(ctx),
    createAcknowledgeMessageRoute(ctx),
    createRegisterDeviceRoute(ctx),
    createListDevicesRoute(ctx),
    ...createPermissionRoutes(ctx)
  ]
}
