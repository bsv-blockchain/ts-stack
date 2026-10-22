import { TrxToken } from '../../../sdk/WalletStorage.interfaces'
import { verifyId, verifyOneOrNone } from '../../../utility/utilityHelpers'
import { TableOutputBasket } from '../tables/TableOutputBasket'
import { upgradeLegacyManagedChangeBasketDefault } from '../../methods/managedChangePolicy'
import { EntityBase, EntityStorage, SyncMap } from './EntityBase'
import { mergeSimpleMetadata } from './mergeSimpleMetadata'

export class EntityOutputBasket extends EntityBase<TableOutputBasket> {
  constructor(
    api?: TableOutputBasket,
    private readonly preserveArchivedPolicy = false
  ) {
    const now = new Date()
    super(
      api || {
        basketId: 0,
        created_at: now,
        updated_at: now,
        userId: 0,
        name: '',
        numberOfDesiredUTXOs: 0,
        minimumDesiredUTXOValue: 0,
        isDeleted: false
      }
    )
  }

  get basketId() {
    return this.api.basketId
  }

  set basketId(v: number) {
    this.api.basketId = v
  }

  get created_at() {
    return this.api.created_at
  }

  set created_at(v: Date) {
    this.api.created_at = v
  }

  get updated_at() {
    return this.api.updated_at
  }

  set updated_at(v: Date) {
    this.api.updated_at = v
  }

  get userId() {
    return this.api.userId
  }

  set userId(v: number) {
    this.api.userId = v
  }

  get name() {
    return this.api.name
  }

  set name(v: string) {
    this.api.name = v
  }

  get numberOfDesiredUTXOs() {
    return this.api.numberOfDesiredUTXOs
  }

  set numberOfDesiredUTXOs(v: number) {
    this.api.numberOfDesiredUTXOs = v
  }

  get minimumDesiredUTXOValue() {
    return this.api.minimumDesiredUTXOValue
  }

  set minimumDesiredUTXOValue(v: number) {
    this.api.minimumDesiredUTXOValue = v
  }

  get isDeleted() {
    return this.api.isDeleted
  }

  set isDeleted(v: boolean) {
    this.api.isDeleted = v
  }

  override get id() {
    return this.api.basketId
  }

  override set id(v: number) {
    this.api.basketId = v
  }

  override get entityName(): string {
    return 'outputBasket'
  }

  override get entityTable(): string {
    return 'output_baskets'
  }

  override updateApi(): void {
    /* nothing needed yet... */
  }

  override equals(ei: TableOutputBasket, syncMap?: SyncMap): boolean {
    const eo = this.api
    if (
      eo.name != ei.name ||
      eo.numberOfDesiredUTXOs != ei.numberOfDesiredUTXOs ||
      eo.minimumDesiredUTXOValue != ei.minimumDesiredUTXOValue
    ) {
      return false
    }
    if (syncMap != null) {
      if (eo.basketId !== syncMap.outputBasket.idMap[verifyId(ei.basketId)]) return false
    } else if (eo.basketId !== ei.basketId || eo.userId !== ei.userId) {
      return false
    }
    return true
  }

  static async mergeFind(
    storage: EntityStorage,
    userId: number,
    ei: TableOutputBasket,
    syncMap: SyncMap,
    trx?: TrxToken,
    preserveArchivedPolicy = false
  ): Promise<{ found: boolean; eo: EntityOutputBasket; eiId: number }> {
    const ef = verifyOneOrNone(
      await storage.findOutputBaskets({
        partial: { name: ei.name, userId },
        trx
      })
    )
    return {
      found: ef != null,
      eo: new EntityOutputBasket(ef || { ...ei }, preserveArchivedPolicy),
      eiId: verifyId(ei.basketId)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void> {
    this.userId = userId
    this.name ||= 'default'
    this.basketId = 0
    if (!this.preserveArchivedPolicy) this.api = upgradeLegacyManagedChangeBasketDefault(this.api)
    this.basketId = await storage.insertOutputBasket(this.toApi(), trx)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async mergeExisting(
    storage: EntityStorage,
    since: Date | undefined,
    ei: TableOutputBasket,
    syncMap: SyncMap,
    trx?: TrxToken
  ): Promise<boolean> {
    let wasMerged = false
    const selected = mergeSimpleMetadata(this.api, ei)
    if (selected !== undefined) {
      // basket name is its identity, should not change
      const incoming = this.preserveArchivedPolicy ? ei : upgradeLegacyManagedChangeBasketDefault(ei)
      this.minimumDesiredUTXOValue = incoming.minimumDesiredUTXOValue
      this.numberOfDesiredUTXOs = incoming.numberOfDesiredUTXOs
      Object.assign(this.api, selected)
      await storage.updateOutputBasket(this.id, this.toApi(), trx)
      wasMerged = true
    }
    return wasMerged
  }
}
