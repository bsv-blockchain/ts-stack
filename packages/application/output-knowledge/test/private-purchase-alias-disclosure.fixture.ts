import { PrivatePurchaseDisclosure } from '../src/private/PrivatePurchaseDisclosure.js'
import {
  PrivatePurchaseAliasDisclosure,
  type PrivatePurchaseAliasReports
} from '../src/private/PrivatePurchaseAliasDisclosure.js'
import { purchaseAliasCoordinatorFixture } from './private-purchase-alias-coordinator.fixture.js'

/** Actual native HTTP custody fence with controlled domain/admission/chain
 * premises. The independent SDK corpus separately exercises genuine SPV. */
export async function purchaseAliasDisclosureFixture(options: { prepareOnly?: boolean } = {}) {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    const paid = f.f.f.variant(70)
    const selected = f.f.f.variant(71)
    if (options.prepareOnly !== true) {
      await f.submit(paid)
      f.setMined(true)
      await f.submit(selected)
    }
    const native = () =>
      new PrivatePurchaseDisclosure(
        f.installation.serviceDomain,
        f.installation.store,
        f.installation.contracts,
        f.installation.access,
        f.installation.clock,
        () => true
      )
    const make = (reports: PrivatePurchaseAliasReports = f.coordinator) =>
      new PrivatePurchaseAliasDisclosure(native(), reports)
    return { f, paid, selected, native, make, id: f.f.base.id, caller: f.base.caller }
  } catch (error) {
    await f.dispose()
    throw error
  }
}
