// Export all permission-related routes
import setPermission from './setPermission.js'
import getPermission from './getPermission.js'
import getQuote from './getQuote.js'
import listPermissions from './listPermissions.js'

export const permissionRoutes = [
  setPermission,
  getPermission,
  getQuote,
  listPermissions
]
