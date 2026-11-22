/** Keep only the last valid screenshot on each talk socket until a turn needs it. */
const MAX_SCREEN_BYTES = 1_500_000
const screens = new WeakMap<object, { jpeg: Buffer; receivedAt: number }>()

export function clearTalkScreen(socket: object): void {
  screens.delete(socket)
}

export function receiveTalkScreen(socket: object, frame: Record<string, unknown>): void {
  if (frame.off === true) return clearTalkScreen(socket)
  const { image } = frame
  if (typeof image !== 'string') throw new Error('screen image must be a base64 JPEG')
  if (image.length > 4 * Math.ceil(MAX_SCREEN_BYTES / 3)) throw new Error('screen image exceeds 1.5 MB')
  const jpeg = Buffer.from(image, 'base64')
  if (jpeg.length > MAX_SCREEN_BYTES) throw new Error('screen image exceeds 1.5 MB')
  if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff || jpeg.toString('base64') !== image) {
    throw new Error('screen image must be a base64 JPEG')
  }
  screens.set(socket, { jpeg, receivedAt: Date.now() })
}

export function latestTalkScreen(socket: object, now = Date.now()): Buffer | undefined {
  const screen = screens.get(socket)
  if (screen && now - screen.receivedAt < 10_000) return screen.jpeg
  clearTalkScreen(socket)
}
