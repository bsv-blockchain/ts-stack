export default function isImageUrl(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const img = new window.Image()
    const finish = (loaded: boolean) => {
      clearTimeout(timeout)
      img.onload = null
      img.onerror = null
      resolve(loaded)
    }
    const timeout = setTimeout(() => finish(false), 1500)
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = url
  })
}
