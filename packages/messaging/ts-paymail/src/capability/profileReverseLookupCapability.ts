import Capability from './capability.js'

/**
 * BRC-235 public profile reverse lookup: the profile certificate an identity
 * key holds at this host.
 */
const ProfileReverseLookupCapability = new Capability({
  code: '43dcf83ddc5f',
  title: 'public profile reverse lookup',
  authors: ['Deggen'],
  version: 'v1.0.0'
})

export default ProfileReverseLookupCapability
