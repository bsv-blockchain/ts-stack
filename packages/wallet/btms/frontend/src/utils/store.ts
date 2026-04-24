// import { create } from 'zustand'
// import { DiscoverByAttributesArgs, DiscoverByAttributes } from '@bsv/sdk'
// import { AssetStore, SigniaResult } from '../types/metanet-asset-types'

// const isAssetKey = (key) => {
//   const regex = /^(02|03|04)[0-9a-fA-F]{64}$/
//   return regex.test(key)
// }

// export const useStore = create<AssetStore>((set) => ({
//   identities: [],
//   fetchIdentities: async (query: string, setIsLoading) => {
//     setIsLoading(true)
//     let results
//     // Figure out if the query is by AssetKey
//     if (isAssetKey(query)) {
//       results = await discoverByIdentityKey({
//         identityKey: query,
//         description: 'Discover MetaNet Identity'
//       })
//     } else {
//       results = await discoverByAttributes({
//         attributes: {
//           any: query
//         },
//         description: 'Discover MetaNet Identity'
//       })
//     }

//     const matchingIdentities = (results as SigniaResult[]).map((x: SigniaResult) => {

//       // Test adding varied name props
//       const nameParts: string[] = []
//       for (const key in x.decryptedFields) {
//         if (key === 'profilePhoto') {
//           continue
//         }
//         nameParts.push(x.decryptedFields[key])
//       }

//       return {
//         name: nameParts.join(' '),
//         profilePhoto: x.decryptedFields.profilePhoto,
//         identityKey: x.subject,
//         certifier: x.certifier
//       }
//     })
//     setIsLoading(false)

//     set({ identities: matchingIdentities })
//   },
// }))
