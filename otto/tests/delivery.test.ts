import { test, expect } from 'bun:test'
import { DeliveryAcks } from '../delivery.ts'

const socket = (desk = false) => ({ data: { tokenId: 'device', ...(desk ? { desk: { focused: false, at: 0, activeAt: 0 } } : {}) }, send: () => {} })
const wait = () => Bun.sleep(35)

test('negotiated phone without receipt fires Bark; desktop receipt cannot cancel it', async () => {
  const phone = socket(), desk = socket(true)
  const acks = new DeliveryAcks(10)
  acks.frame(phone, '{"type":"hello","messageAcks":true}')
  acks.frame(desk, '{"type":"hello","messageAcks":true}')
  let pushes = 0
  acks.watch('m', [phone, desk], () => pushes++)
  acks.frame(desk, '{"type":"ack","id":"m"}')
  await wait()
  expect(pushes).toBe(1)
})

test('receipt must be from a negotiated phone to which the message was sent', async () => {
  const phone = socket(), stranger = socket()
  const acks = new DeliveryAcks(10)
  for (const s of [phone, stranger]) acks.frame(s, '{"type":"hello","messageAcks":true}')
  let pushes = 0
  acks.watch('m', [phone], () => pushes++)
  acks.frame(stranger, '{"type":"ack","id":"m"}')
  acks.frame(phone, '{"type":"ack","id":"other"}')
  await wait()
  expect(pushes).toBe(1)
  acks.watch('next', [phone], () => pushes++)
  acks.frame(phone, '{"type":"ack","id":"next"}')
  await wait()
  expect(pushes).toBe(1)
})

test('old clients without the hello flag retain socket-is-live behavior', async () => {
  const acks = new DeliveryAcks(10), old = socket(), modern = socket()
  acks.frame(old, '{"type":"hello","messageAcks":false}')
  acks.frame(modern, '{"type":"hello","messageAcks":true}')
  let pushes = 0
  acks.watch('old', [old], () => pushes++)
  acks.watch('mixed', [old, modern], () => pushes++)
  acks.watch('desktop', [socket(true)], () => pushes++)
  await wait()
  expect(pushes).toBe(0)
})

test('closing a negotiated phone does not discard its outstanding fallback', async () => {
  const acks = new DeliveryAcks(10), phone = socket()
  acks.frame(phone, '{"type":"hello","messageAcks":true}')
  let pushes = 0
  const sockets = new Set([phone])
  acks.watch('m', sockets, () => pushes++)
  sockets.delete(phone)
  expect(sockets.size).toBe(0)
  await wait()
  expect(pushes).toBe(1)
})

test('malformed client frames cannot crash receipt handling', () => {
  const acks = new DeliveryAcks(), phone = socket()
  for (const frame of ['null', '[]', '42', '{', '{"type":"ack","id":{}}']) expect(() => acks.frame(phone, frame)).not.toThrow()
})


test('late desktop classification cannot consume a phone receipt timeout', async () => {
  for (const negotiated of [true, false]) {
    const acks = new DeliveryAcks(10), phone = socket(), mac = socket()
    acks.frame(phone, '{"type":"hello","messageAcks":true}')
    if (negotiated) acks.frame(mac, '{"type":"hello","messageAcks":true}')
    let pushes = 0
    acks.watch('message', [phone, mac], () => pushes++)
    acks.frame(mac, '{"type":"ack","id":"message"}')
    mac.data.desk = { focused: false, at: 0, activeAt: 0 }
    await wait()
    expect(pushes).toBe(1)
  }
})

test('desktop hello classifies the socket before message receipt decisions', async () => {
  const acks = new DeliveryAcks(10), mac = socket(), phone = socket()
  acks.frame(mac, '{"type":"hello","messageAcks":true,"desktop":true}')
  acks.frame(phone, '{"type":"hello","messageAcks":true}')
  expect(mac.data.desk).toBeTruthy()
  let pushes = 0
  acks.watch('message', [phone, mac], () => pushes++)
  acks.frame(mac, '{"type":"ack","id":"message"}')
  await wait()
  expect(pushes).toBe(1)
})
