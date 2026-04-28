import PaymailRoute from './paymailRoute.js'
import NegotiationCapabilities from '../../capability/negotiationCapabilities.js'

interface NegotiationCapabilitiesResponse {
  send_disabled: boolean
  auto_send_response: boolean
  receive: boolean
  three_step_exchange: boolean
  four_step_exchange: boolean
  auto_exchange_response: boolean
}

interface NegotiationCapabilitiesRouteConfig {
  endpoint?: string
  send_disabled: false
  auto_send_response: false
  receive: false
  three_step_exchange: false
  four_step_exchange: false
  auto_exchange_response: false
}

export default class TransactionNegotiationCapabilitiesRoute extends PaymailRoute {
  constructor (config: NegotiationCapabilitiesRouteConfig) {
    super({
      capability: NegotiationCapabilities,
      endpoint: config.endpoint || '/transaction-negotiation-capabilities/:paymail',
      domainLogicHandler: async () => {
        return {
          send_disabled: config.send_disabled,
          auto_send_response: config.auto_send_response,
          receive: config.receive,
          three_step_exchange: config.three_step_exchange,
          four_step_exchange: config.four_step_exchange,
          auto_exchange_response: config.auto_exchange_response
        }
      }
    })
  }

  protected serializeResponse (domainLogicResponse: NegotiationCapabilitiesResponse): string {
    return JSON.stringify({
      send_disabled: domainLogicResponse.send_disabled,
      auto_send_response: domainLogicResponse.auto_send_response,
      receive: domainLogicResponse.receive,
      three_step_exchange: domainLogicResponse.three_step_exchange,
      four_step_exchange: domainLogicResponse.four_step_exchange,
      auto_exchange_response: domainLogicResponse.auto_exchange_response
    })
  }
}
