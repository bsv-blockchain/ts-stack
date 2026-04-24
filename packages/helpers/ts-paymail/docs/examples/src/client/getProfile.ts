import { PaymailClient } from '@bsv/paymail'
import { mockUser1, mockUser2 } from '../mockUser'

const client = new PaymailClient();

(async () => {
  const user1Paymail = mockUser1.getPaymail()
  const user2Paymail = mockUser2.getPaymail()
  const publicProfile1 = await client.getPublicProfile(user1Paymail)
  const publicProfile2 = await client.getPublicProfile(user2Paymail)
  console.log({
    publicProfile1,
    publicProfile2
  })
})()
