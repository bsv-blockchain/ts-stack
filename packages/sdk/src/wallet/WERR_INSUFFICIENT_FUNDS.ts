/**
 * Insufficient funds in the available inputs to cover the cost of the required outputs
 * and the transaction fee (${moreSatoshisNeeded} more satoshis are needed,
 * for a total of ${totalSatoshisNeeded}), plus whatever would be required in order
 * to pay the fee to unlock and spend the outputs used to provide the additional satoshis.
 */
export class WERR_INSUFFICIENT_FUNDS extends Error {
  code: number
  isError: boolean = true

  /**
   * @param totalSatoshisNeeded Total satoshis required to fund transactions after net of required inputs and outputs.
   * @param moreSatoshisNeeded Shortfall on total satoshis required to fund transactions after net of required inputs and outputs.
   */
  constructor (
    public totalSatoshisNeeded: number,
    public moreSatoshisNeeded: number
  ) {
    super(`Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (${moreSatoshisNeeded} more satoshis are needed, for a total of ${totalSatoshisNeeded}), plus whatever would be required in order to pay the fee to unlock and spend the outputs used to provide the additional satoshis.`)
    this.code = 7
    this.name = this.constructor.name
  }
}

export default WERR_INSUFFICIENT_FUNDS
