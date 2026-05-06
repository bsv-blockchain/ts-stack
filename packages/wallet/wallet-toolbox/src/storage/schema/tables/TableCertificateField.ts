import { Base64String } from '@bsv/sdk'
import * as sdk from '../../../sdk'

export interface TableCertificateField extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  userId: number
  certificateId: number
  fieldName: string
  fieldValue: string
  masterKey: Base64String
}
