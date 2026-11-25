import { toast } from 'react-toastify'

export function copyToClipboard(text: string, onCopied?: () => void): void {
  const reportFailure = () => toast.error('Could not copy to the clipboard.')
  if (!navigator.clipboard) {
    reportFailure()
    return
  }
  navigator.clipboard.writeText(text).then(onCopied).catch(reportFailure)
}
