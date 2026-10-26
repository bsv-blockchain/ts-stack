import PrivateKey from './PrivateKey.js'
import BigNumber from './BigNumber.js'
import Curve from './Curve.js'
import Random from './Random.js'
import { fromBase58, toBase58 } from './utils.js'

export const MAX_SHAMIR_SHARES = 255
const MAX_POINT_STRING_LENGTH = 129
const BASE58_FIELD = /^[1-9A-HJ-NP-Za-km-z]{1,64}$/

function assertPolynomialThreshold(threshold: number, pointCount: number, minimum: number): void {
  if (!Number.isSafeInteger(threshold) || threshold < minimum || threshold > MAX_SHAMIR_SHARES) {
    throw new TypeError(`threshold must be a safe integer from ${minimum} to ${MAX_SHAMIR_SHARES}`)
  }
  if (threshold > pointCount) throw new Error('threshold cannot exceed the number of points')
}

export class PointInFiniteField {
  x: BigNumber
  y: BigNumber

  constructor (x: BigNumber, y: BigNumber) {
    const P = new Curve().p // arithmetic is mod P
    this.x = x.umod(P)
    this.y = y.umod(P)
  }

  toString (): string {
    return toBase58(this.x.toArray()) + '.' + toBase58(this.y.toArray())
  }

  static fromString (str: string): PointInFiniteField {
    if (typeof str !== 'string' || str.length > MAX_POINT_STRING_LENGTH) {
      throw new TypeError('Finite-field point must use a bounded canonical Base58 representation')
    }
    const [x, y, extra] = str.split('.')
    if (extra !== undefined || x === undefined || y === undefined || !BASE58_FIELD.test(x) || !BASE58_FIELD.test(y)) {
      throw new TypeError('Finite-field point must use a bounded canonical Base58 representation')
    }
    const point = new PointInFiniteField(
      new BigNumber(fromBase58(x)),
      new BigNumber(fromBase58(y))
    )
    if (point.toString() !== str) {
      throw new TypeError('Finite-field point must use a bounded canonical Base58 representation')
    }
    return point
  }
}

/**
 * Polynomial class
 *
 * This class is used to create a polynomial with a given threshold and a private key.
 * The polynomial is used to create shares of the private key.
 *
 * @param key - The private key to split
 * @param threshold - The number of shares required to recombine the private key
 *
 * @example
 * const key = new PrivateKey()
 * const threshold = 2
 * const polynomial = new Polynomial(key, threshold)
 *
 */
export default class Polynomial {
  readonly points: PointInFiniteField[]
  readonly threshold: number

  constructor (points: PointInFiniteField[], threshold?: number) {
    if (!Array.isArray(points) || points.length === 0 || points.length > MAX_SHAMIR_SHARES) {
      throw new TypeError(`points must contain from 1 to ${MAX_SHAMIR_SHARES} entries`)
    }
    const resolvedThreshold = threshold ?? points.length
    assertPolynomialThreshold(resolvedThreshold, points.length, 1)
    this.points = points.slice()
    this.threshold = resolvedThreshold
  }

  static fromPrivateKey (key: PrivateKey, threshold: number): Polynomial {
    if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > MAX_SHAMIR_SHARES) {
      throw new TypeError(`threshold must be a safe integer from 2 to ${MAX_SHAMIR_SHARES}`)
    }
    const P = new Curve().p // arithmetic is mod P
    // The key is the y-intercept of the polynomial where x=0.
    const points = [
      new PointInFiniteField(new BigNumber(0), new BigNumber(key.toArray()))
    ]

    // The other values are random
    for (let i = 1; i < threshold; i++) {
      const randomX = new BigNumber(Random(32)).umod(P)
      const randomY = new BigNumber(Random(32)).umod(P)
      points.push(new PointInFiniteField(randomX, randomY))
    }

    return new Polynomial(points)
  }

  // Evaluate the polynomial at x by using Lagrange interpolation
  valueAt (x: BigNumber): BigNumber {
    assertPolynomialThreshold(this.threshold, this.points.length, 1)
    if (!(x instanceof BigNumber)) throw new TypeError('x must be a BigNumber')
    const P = new Curve().p // arithmetic is mod P
    const seenXCoordinates = new Set<string>()
    for (let index = 0; index < this.threshold; index++) {
      const point = this.points[index]
      if (!(point instanceof PointInFiniteField) || !(point.x instanceof BigNumber) || !(point.y instanceof BigNumber)) {
        throw new TypeError('points must contain finite-field points')
      }
      if (point.x.isNeg() || point.y.isNeg() || point.x.gte(P) || point.y.gte(P)) {
        throw new TypeError('point coordinates must be canonical field elements')
      }
      const xCoordinate = point.x.toString(16)
      if (seenXCoordinates.has(xCoordinate)) throw new Error('Polynomial points must have unique x coordinates')
      seenXCoordinates.add(xCoordinate)
    }
    const normalizedX = x.umod(P)
    let y = new BigNumber(0)
    for (let i = 0; i < this.threshold; i++) {
      let term = this.points[i].y
      for (let j = 0; j < this.threshold; j++) {
        if (i !== j) {
          const xj = this.points[j].x
          const xi = this.points[i].x

          const numerator = normalizedX.sub(xj).umod(P)
          const denominator = xi.sub(xj).umod(P)
          const denominatorInverse = denominator.invm(P)

          const fraction = numerator.mul(denominatorInverse).umod(P)
          term = term.mul(fraction).umod(P)
        }
      }
      y = y.add(term).umod(P)
    }
    return y
  }
}
