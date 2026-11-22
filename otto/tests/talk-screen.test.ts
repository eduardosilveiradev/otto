import { expect, test } from 'bun:test'
import { latestTalkScreen, receiveTalkScreen } from '../talk-screen.ts'

test('latest screenshot expires ten seconds after receipt', () => {
  const socket = {}
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  receiveTalkScreen(socket, { image: jpeg.toString('base64') })
  expect(latestTalkScreen(socket)).toEqual(jpeg)
  expect(latestTalkScreen(socket, Date.now() + 10_000)).toBeUndefined()
  expect(latestTalkScreen(socket)).toBeUndefined()
})
