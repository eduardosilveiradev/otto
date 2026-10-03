import { test, expect } from 'bun:test'
import { headlessMcpArgs, headlessMcpConfig, HEADLESS_SERVER_NAME } from '../headless'

test('strict mode is always on, so channel plugins never load', () => {
  for (const otto of [true, false]) {
    const args = headlessMcpArgs({ otto }, '/x/otto')
    expect(args[0]).toBe('--strict-mcp-config')
    expect(args[1]).toBe('--mcp-config')
    expect(() => JSON.parse(args[2]!)).not.toThrow()
  }
})

test('otto:true adds back only this plugin, under the name that keeps tool ids stable', () => {
  const cfg = headlessMcpConfig({ otto: true }, '/x/otto')
  expect(Object.keys(cfg.mcpServers)).toEqual([HEADLESS_SERVER_NAME])
  expect(cfg.mcpServers[HEADLESS_SERVER_NAME]).toEqual({ command: 'bun', args: ['/x/otto/server.ts'] })
  expect(`mcp__${HEADLESS_SERVER_NAME}__recall`).toBe('mcp__plugin_otto_otto__recall')
})

test('otto:false adds nothing back', () => {
  expect(headlessMcpConfig({ otto: false }, '/x/otto').mcpServers).toEqual({})
})

test('the default dir is this module, i.e. the plugin root', () => {
  const [, , json] = headlessMcpArgs({ otto: true })
  const cfg = JSON.parse(json!) as ReturnType<typeof headlessMcpConfig>
  expect(cfg.mcpServers[HEADLESS_SERVER_NAME]!.args[0]).toBe(new URL('../server.ts', import.meta.url).pathname)
})
