export function createToneWav(durationSeconds = 2, frequency = 220): Uint8Array {
  const sampleRate = 22_050
  const samples = Math.floor(sampleRate * durationSeconds)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 300) * Math.min(1, (samples - index) / 800)
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * envelope
    view.setInt16(44 + index * 2, Math.round(sample * 0x5fff), true)
  }
  return bytes
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}
