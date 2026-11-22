import { test, expect } from 'bun:test'
import { CommandError, runChecked } from '../workspace.ts'

test('checked commands capture stderr and exit status', async () => {
  try {
    await runChecked([process.execPath, '-e', 'console.error("merge refused"); process.exit(7)'])
    throw new Error('expected command failure')
  } catch (err) {
    expect(err).toBeInstanceOf(CommandError)
    expect(err).toMatchObject({ stderr: 'merge refused\n', exitCode: 7, timedOut: false })
  }
})

test('checked commands cannot wait for stdin, and timeouts are explicit', async () => {
  expect(await runChecked([process.execPath, '-e', 'console.log(await Bun.stdin.text())'])).toBe('')
  await expect(runChecked([process.execPath, '-e', 'setInterval(() => {}, 1000)'], undefined, 30))
    .rejects.toMatchObject({ timedOut: true })
})

test('checked commands report a missing executable', async () => {
  await expect(runChecked(['otto-nonexistent-test-executable'])).rejects.toMatchObject({ exitCode: null, timedOut: false })
})
