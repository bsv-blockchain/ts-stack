import Capability from './capability.js'

/**
 * BRC-235 public profile lookup: search a host's handles, answered with
 * self-signed profile certificates.
 */
const ProfileLookupCapability = new Capability({
  code: '0ace65da5987',
  title: 'public profile lookup',
  authors: ['Deggen'],
  version: 'v1.0.0'
})

export default ProfileLookupCapability
