import { test, expect } from 'bun:test'
import { redactSecrets, redactionNote, validIban } from '../redact.ts'

// Every secret below is a fake, assembled from pieces at runtime so no literal
// in this file has the shape a secret scanner looks for.
const rep = (s: string, n: number) => s.repeat(n)
const FAKE = {
  aws: 'AKIA' + 'FAKEFAKE' + 'EXAMPLE1',
  awsTemp: 'ASIA' + 'FAKEFAKE' + 'EXAMPLE2',
  ghp: 'ghp' + '_' + rep('Fake0', 7) + 'X',
  gho: 'gho' + '_' + rep('Fake1', 7) + 'X',
  ghs: 'ghs' + '_' + rep('Fake2', 7) + 'X',
  ghPat: 'github' + '_pat_' + rep('FAKE0', 5) + '_' + rep('fake9', 12),
  slack: 'xox' + 'b-' + '1234567890' + '-' + rep('fakeFAKE', 3),
  openai: 'sk' + '-proj-' + rep('fAkE1', 8),
  openaiLegacy: 'sk' + '-' + rep('Fake2', 9),
  anthropic: 'sk' + '-ant-' + 'api03-' + rep('fAkE3', 16),
  google: 'AI' + 'za' + rep('FakeKey0', 4) + 'abc',
  stripe: 'sk' + '_live_' + rep('Fake4', 6),
  stripeRestricted: 'rk' + '_live_' + rep('Fake5', 6),
  telegram: '1234567890' + ':' + 'AA' + rep('FakeTok', 4) + 'Fake5',
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'J' + 'zdWIiOiJmYWtlIn0' + '.' + rep('fakeSig_', 3),
  bearer: 'fake' + 'Opaque' + 'Token' + '0123456789',
  key:
    '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' +
    rep('FAKEKEYMATERIALfakekeymaterial', 2) + '\n' + 'notarealkey==\n' +
    '-----END ' + 'RSA PRIVATE KEY-----',
  // Published textbook examples, which pass mod-97 by design.
  ibanSpaced: 'GB82 ' + 'WEST ' + '1234 5698 7654 32',
  ibanCompact: 'DE89' + '3704' + '0044' + '0532' + '0130' + '00',
}

const one = (secret: string, kind: string) => {
  const { text, hits } = redactSecrets(`here it is: ${secret} — keep it safe`)
  expect(hits).toEqual([kind])
  expect(text).toBe(`here it is: [redacted ${kind}] — keep it safe`)
  expect(text).not.toContain(secret)
}

test('AWS access keys, long-term and temporary', () => {
  one(FAKE.aws, 'AWS access key')
  one(FAKE.awsTemp, 'AWS access key')
})

test('GitHub tokens of every prefix', () => {
  for (const t of [FAKE.ghp, FAKE.gho, FAKE.ghs, FAKE.ghPat]) one(t, 'GitHub token')
})

test('Slack tokens', () => one(FAKE.slack, 'Slack token'))

test('OpenAI keys, project and legacy', () => {
  one(FAKE.openai, 'OpenAI key')
  one(FAKE.openaiLegacy, 'OpenAI key')
})

test('Anthropic keys are named as such, not as OpenAI', () => one(FAKE.anthropic, 'Anthropic key'))

test('Google API keys', () => one(FAKE.google, 'Google API key'))

test('Stripe live secret and restricted keys', () => {
  one(FAKE.stripe, 'Stripe key')
  one(FAKE.stripeRestricted, 'Stripe key')
})

test('Telegram bot tokens, bare and inside an API URL', () => {
  one(FAKE.telegram, 'Telegram bot token')
  const { text, hits } = redactSecrets(`curl https://api.telegram.org/bot${FAKE.telegram}/getMe`)
  expect(hits).toEqual(['Telegram bot token'])
  expect(text).toBe('curl https://api.telegram.org/bot[redacted Telegram bot token]/getMe')
})

test('JWTs', () => one(FAKE.jwt, 'JWT'))

test('bearer tokens keep the header and lose the token', () => {
  const { text, hits } = redactSecrets(`-H 'Authorization: Bearer ${FAKE.bearer}'`)
  expect(hits).toEqual(['bearer token'])
  expect(text).toBe("-H 'Authorization: Bearer [redacted bearer token]'")
  const json = redactSecrets(`{"Authorization": "Bearer ${FAKE.bearer}"}`)
  expect(json.text).toBe('{"Authorization": "Bearer [redacted bearer token]"}')
})

test('a JWT used as a bearer token is reported once, as a JWT', () => {
  const { text, hits } = redactSecrets(`authorization: bearer ${FAKE.jwt}`)
  expect(hits).toEqual(['JWT'])
  expect(text).toBe('authorization: bearer [redacted JWT]')
})

test('private key blocks, whole and truncated', () => {
  one(FAKE.key, 'private key')
  const pgp = '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----\nfakefake\n-----END ' + 'PGP PRIVATE KEY BLOCK-----'
  one(pgp, 'private key')
  const cut = redactSecrets('output:\n' + FAKE.key.slice(0, 60))
  expect(cut).toEqual({ text: 'output:\n[redacted private key]', hits: ['private key'] })
})

test('IBANs that pass the checksum, spaced and compact', () => {
  one(FAKE.ibanSpaced, 'IBAN')
  one(FAKE.ibanCompact, 'IBAN')
})

test('a spaced IBAN followed by a capitalised word keeps the word', () => {
  const { text } = redactSecrets(`pay ${FAKE.ibanSpaced} IS the account`)
  expect(text).toBe('pay [redacted IBAN] IS the account')
})

test('an IBAN with a bad checksum is left alone', () => {
  const bad = 'GB83 ' + 'WEST ' + '1234 5698 7654 32'
  expect(validIban(bad)).toBe(false)
  const badCompact = 'DE88' + '3704' + '0044' + '0532' + '0130' + '00'
  for (const s of [bad, badCompact]) {
    expect(redactSecrets(`ref ${s}`)).toEqual({ text: `ref ${s}`, hits: [] })
  }
})

test('ordinary identifiers and prose are left alone', () => {
  const benign = [
    'merged as 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f, short sha 3f9c2a1',
    'request id 123e4567-e89b-12d3-a456-426614174000',
    'your code is 482913',
    'meeting at 10:30 CEST, then 14:00:00 UTC',
    'sk-learn is spelled scikit-learn; the task-tracker-for-the-whole-team is fine',
    'Order 1234567890 shipped. Call +44 20 7946 0100.',
    'Bearer bonds are a thing. Authorization: pending.',
    'eyJ alone is not a token, and neither is a.b.c',
    'ISBN 978-3-16-148410-0, invoice INV-2026-0042, flight LH 1234',
    'Think DE12 days ahead, GB plans for 2027.',
  ]
  for (const s of benign) expect(redactSecrets(s)).toEqual({ text: s, hits: [] })
})

test('several secrets in one message are all caught and counted', () => {
  const msg = [
    `AWS_ACCESS_KEY_ID=${FAKE.aws}`,
    `GITHUB_TOKEN=${FAKE.ghp}`,
    `OPENAI_API_KEY=${FAKE.openai}`,
    `ANTHROPIC_API_KEY=${FAKE.anthropic}`,
    `transfer to ${FAKE.ibanCompact}`,
    'HEAD is 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f',
  ].join('\n')
  const { text, hits } = redactSecrets(msg)
  expect(hits.length).toBe(5)
  expect(new Set(hits)).toEqual(new Set(['AWS access key', 'GitHub token', 'OpenAI key', 'Anthropic key', 'IBAN']))
  for (const s of [FAKE.aws, FAKE.ghp, FAKE.openai, FAKE.anthropic, FAKE.ibanCompact]) {
    expect(text).not.toContain(s)
  }
  expect(text).toContain('HEAD is 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f')
  expect(text).toContain('AWS_ACCESS_KEY_ID=[redacted AWS access key]')
  expect(redactionNote(hits)).toBe(
    'redacted 5 secret(s): Anthropic key, OpenAI key, GitHub token, AWS access key, IBAN',
  )
})

test('the note counts every hit but names each kind once', () => {
  expect(redactionNote([])).toBe('')
  expect(redactionNote(['GitHub token', 'GitHub token', 'IBAN'])).toBe('redacted 3 secret(s): GitHub token, IBAN')
})

test('MarkdownV2 sends get escaped brackets', () => {
  const { text } = redactSecrets(`token ${FAKE.ghp}`, { markdownV2: true })
  expect(text).toBe('token \\[redacted GitHub token\\]')
})

test('the same text twice redacts the same way, and redacted text is a fixed point', () => {
  const first = redactSecrets(`${FAKE.stripe} ${FAKE.google}`)
  expect(redactSecrets(first.text)).toEqual({ text: first.text, hits: [] })
})
