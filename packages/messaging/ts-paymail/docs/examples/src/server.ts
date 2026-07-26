/*
 * Example SRV Record for Paymail:
 * -----------------------------------------------------------
 * Service: _bsvalias
 * Protocol: _tcp
 * Name: yourdomain.com (Replace with your actual domain)
 * Priority: 10
 * Weight: 10
 * Port: 443 (Assuming HTTPS)
 * Target: myDomain.com (Replace with your domain or the address of your server)
 * TTL: 3600 (1 hour, can be lower for testing)
 *
 * Adding the SRV Record:
 * 1. Log into your DNS provider's control panel.
 * 2. Navigate to the DNS management section.
 * 3. Add a new SRV record with the above details.
 *
 * Enabling DNSSEC:
 * 1. Log into your domain registrar's control panel.
 * 2. Go to the DNS settings for your domain.
 * 3. Look for an option to enable DNSSEC and activate it.
 * 4. If DNSSEC details are managed externally, enter the DS record details provided by your DNS hosting provider.
 * 5. Save your changes and allow time for propagation.
 */

import express from 'express'
import p2pDestinationsRoute from './server/p2pDestinations'
import receiveTransactionRoute from './server/receiveTransaction'
import receiveBeefTransactionRoute from './server/receiveBeefTransaction'
import publicProfileRoute from './server/publicProfile'
import pkiRoute from './server/pki'
import { PaymailRouter } from '@bsv/paymail'

const app = express()
app.disable('x-powered-by')
const DOMAIN = process.env.DOMAIN ?? 'localhost' // Replace with your actual domain
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error('PORT must be an integer from 1 through 65535')
}
const defaultBaseUrl = DOMAIN === 'localhost' ? `http://${DOMAIN}:${PORT}` : `https://${DOMAIN}`
const baseUrl = process.env.PAYMAIL_BASE_URL ?? defaultBaseUrl

const routes = [
  publicProfileRoute,
  pkiRoute,
  p2pDestinationsRoute,
  receiveTransactionRoute,
  receiveBeefTransactionRoute
]
const paymailRouter = new PaymailRouter({ baseUrl, routes })
app.use(paymailRouter.getRouter())

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} and advertising ${baseUrl}`)
})
