'use client'

import { RequestLog as RequestLogBase } from '@bsv/wallet-relay/react'
import type { RequestLogEntry } from '../types/wallet'

interface Props {
  entries: RequestLogEntry[]
}

export function RequestLog({ entries }: Props) {
  return (
    <RequestLogBase
      entries={entries}
      className="flex flex-col gap-2 overflow-y-auto max-h-72"
      emptyProps={{ className: 'text-xs text-gray-400 text-center py-6' }}
      entryProps={{
        className: [
          'rounded-lg border p-3 text-xs font-mono',
          'data-[state=pending]:border-yellow-200 data-[state=pending]:bg-yellow-50',
          'data-[state=error]:border-red-200 data-[state=error]:bg-red-50',
          'data-[state=ok]:border-green-200 data-[state=ok]:bg-green-50',
          '[&_[data-log-method]]:font-semibold [&_[data-log-method]]:text-gray-700',
          '[&_[data-log-status]]:text-gray-400 [&_[data-log-status]]:float-right',
          '[&_[data-log-result]]:block [&_[data-log-result]]:mt-1 [&_[data-log-result]]:text-gray-600',
          '[&_[data-log-result]]:whitespace-pre-wrap [&_[data-log-result]]:break-all',
        ].join(' '),
      }}
    />
  )
}
