import {
  type WalletPermissionsManager,
  type WalletPermissionsManagerCallbacks,
  type PermissionEventHandler,
  type GroupedPermissionEventHandler,
  type CounterpartyPermissionEventHandler,
  type GroupedPermissionRequest,
  type CounterpartyPermissionRequest
} from '@bsv/wallet-toolbox'

type IsAny<T> = 0 extends 1 & T ? true : false

/** Declaration consumer: event literals infer actual callback request types,
 * while the established dynamic-event/handler-union signature stays accepted. */
export function registerPermissionCallbacks(manager: WalletPermissionsManager): void {
  for (const event of [
    'onProtocolPermissionRequested',
    'onBasketAccessRequested',
    'onCertificateAccessRequested',
    'onSpendingAuthorizationRequested'
  ] as const) {
    manager.bindCallback(event, request => {
      const requestHasAny: IsAny<typeof request> = false
      const single: Parameters<PermissionEventHandler>[0] = request
      void requestHasAny
      void single.requestID
      void single.originator
      void single.type
    })
  }
  manager.bindCallback('onGroupedPermissionRequested', request => {
    const requestHasAny: IsAny<typeof request> = false
    const grouped: GroupedPermissionRequest = request
    void requestHasAny
    void grouped.requestID
    void grouped.permissions
  })
  manager.bindCallback('onCounterpartyPermissionRequested', request => {
    const requestHasAny: IsAny<typeof request> = false
    const counterparty: CounterpartyPermissionRequest = request
    void requestHasAny
    void counterparty.requestID
    void counterparty.counterparty
    void counterparty.permissions
  })
  const legacy: (
    event: keyof WalletPermissionsManagerCallbacks,
    handler: PermissionEventHandler | GroupedPermissionEventHandler | CounterpartyPermissionEventHandler
  ) => number = manager.bindCallback.bind(manager)
  void legacy
}
