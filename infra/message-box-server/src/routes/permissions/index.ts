import type { MessageBoxContext } from '../../context.js'
import { createSetPermissionRoute } from './setPermission.js'
import { createGetPermissionRoute } from './getPermission.js'
import { createGetQuoteRoute } from './getQuote.js'
import { createListPermissionsRoute } from './listPermissions.js'

export function createPermissionRoutes (ctx: MessageBoxContext) {
  return [
    createSetPermissionRoute(ctx),
    createGetPermissionRoute(ctx),
    createGetQuoteRoute(ctx),
    createListPermissionsRoute(ctx)
  ]
}
