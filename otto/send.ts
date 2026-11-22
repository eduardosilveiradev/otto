import type { Api } from 'grammy'

/** Plain Telegram sends used by queued replies and the setup smoke check. */
export function sendPlainMessage(api: Pick<Api, 'sendMessage'>, chat: string, text: string) {
  return api.sendMessage(chat, text)
}
