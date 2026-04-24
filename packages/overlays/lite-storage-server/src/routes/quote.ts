import { Request, Response } from 'express'
import getPriceForFile from '../utils/getPriceForFile'

const {
  MIN_HOSTING_MINUTES
} = process.env

interface QuoteRequest extends Request {
  body: {
    fileSize: number
    retentionPeriod: number
  }
}

interface QuoteResponse {
  quote?: number
  status?: 'error'
  code?: string
  description?: string
}

const quoteHandler = async (req: QuoteRequest, res: Response<QuoteResponse>) => {
  try {
    const {
      fileSize,
      retentionPeriod
    } = req.body

    // Handle missing fields
    if (!fileSize) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_NO_SIZE',
        description:
          'Provide the size of the file you want to host.'
      })
    }
    if (!retentionPeriod) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_NO_RETENTION_PERIOD',
        description:
          'Specify the number of minutes to host the file.'
      })
    }

    // File size must be a positive integer
    if (!Number.isInteger(Number(fileSize)) || fileSize <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_SIZE',
        description:
          'The file size must be an integer.'
      })
    }

    const minHostingMinutes = Number(MIN_HOSTING_MINUTES) || 0

    // Retention period must be a positive integer more than the minimum
    if (!Number.isInteger(Number(retentionPeriod)) || retentionPeriod < minHostingMinutes) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_RETENTION_PERIOD',
        description: `The retention period must be an integer and must be more than ${MIN_HOSTING_MINUTES} minutes`
      })
    }

    // Retention period must not be more than 69 million minutes
    if (retentionPeriod > 69000000) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_RETENTION_PERIOD',
        description: 'The retention period must be less than 69 million minutes (about 130 years)'
      })
    }

    // The quote is generated and returned
    const satPrice = await getPriceForFile({ fileSize, retentionPeriod })
    return res.status(200).json({ quote: satPrice })
  } catch (e) {
    console.error(e)
    return res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error has occurred.'
    })
  }
}


export default {
  type: 'post',
  path: '/quote',
  summary: 'Use this route to get a quote for what it would cost to host a file for a given duration.',
  parameters: {
    fileSize: 'Specify the size of the file you would like to host in bytes',
    retentionPeriod: 'Specify the whole number of minutes that you want the file to be hosted.'
  },
  exampleResponse: {
    quote: 1024
  },
  errors: [
    'ERR_NO_SIZE',
    'ERR_NO_RETENTION_PERIOD',
    'ERR_INVALID_SIZE',
    'ERR_INVALID_RETENTION_PERIOD',
    'ERR_INTERNAL'
  ],
  func: quoteHandler
}