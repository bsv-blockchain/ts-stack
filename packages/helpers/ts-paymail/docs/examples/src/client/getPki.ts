import { PaymailClient } from '@bsv/paymail'
import { mockUser1, mockUser2 } from '../mockUser'

const client = new PaymailClient();

(async () => {
  const user1Paymail = mockUser1.getPaymail()
  const user2Paymail = mockUser2.getPaymail()
  const pki1 = await client.getPki(user1Paymail)
  const pki2 = await client.getPki(user2Paymail)
  console.log({
    pki1,
    pki2
  })
})()
