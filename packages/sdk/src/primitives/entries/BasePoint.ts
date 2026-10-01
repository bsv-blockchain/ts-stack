// Retain Curve initialization before a cold leaf import. The exact entry file
// is marked side-effectful so bundlers preserve this dependency and call.
import Curve from '../Curve.js'
Curve.assert(true)
export { default } from '../BasePoint.js'
