import { describe, it, expect } from 'vitest'
import { apply } from '../src/index.js'
import { fakeCtx, fakeSession } from './helpers.js'

describe('apply', () => {
  it('registers llm/stream, session/event, agent/request-error, /why and an exporter', () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    expect(Object.keys(ctx._.listeners)).toEqual(expect.arrayContaining(['llm/stream', 'session/event', 'agent/request-error']))
    expect(ctx._.commands[0].name).toBe('why')
    expect(ctx._.exporter).toBeDefined()
  })
  it('works with a raw config missing defaults', () => {
    const ctx = fakeCtx()
    expect(() => apply(ctx, undefined)).not.toThrow()
  })
  it('request-error listener always delegates to next unchanged', async () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    const listener = ctx._.listeners['agent/request-error'][0]
    const session = fakeSession()
    const out = await listener({ agent: { session }, turn: 1, step: 1, provider: 'p',
      failure: { code: 'AUTH', message: '401' } }, () => Promise.resolve({ kind: 'retry' }))
    expect(out).toEqual({ kind: 'retry' })
  })
  it('request-error listener delegates even when its own handling throws', async () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    const listener = ctx._.listeners['agent/request-error'][0]
    const out = await listener({ agent: null, turn: 1, step: 1, provider: 'p',
      failure: { code: 'AUTH', message: '401' } }, () => Promise.resolve(undefined))
    expect(out).toBeUndefined()
    expect(ctx._.logs.some(l => String(l[1]).includes('internal error'))).toBe(true)
  })
  it('llm/stream listener times calls end to end', async () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 }, { now: () => 0 })
    const listener = ctx._.listeners['llm/stream'][0]
    async function* fake() { yield { type: 'finish', reason: { kind: 'stop' } } }
    const out = []
    for await (const c of listener({ sessionId: 's', provider: 'p' }, fake)) out.push(c)
    expect(out).toHaveLength(1)
  })
  it('/why prints newest first and a friendly empty message', async () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    const session = fakeSession()
    const why = ctx._.commands[0]
    expect((await why.handler({ agent: { session } })).text).toContain('No failures')
    const onEvent = ctx._.listeners['session/event'][0]
    onEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })
    const res = await why.handler({ agent: { session } })
    expect(res.kind).toBe('success')
    expect(res.text).toContain('rejected the API key')
  })
  it('/why includes own subagent verdicts and hides other parents\' children', async () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    const onEvent = ctx._.listeners['session/event'][0]
    const mine = fakeSession('deadbeef01', { parentSession: 'session-1' })
    const other = fakeSession('cafebabe02', { parentSession: 'session-9' })
    const fail = (s, turn) => onEvent(s, { type: 'turn/end', seq: turn, data: { turn, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })
    fail(mine, 1); fail(other, 1)
    const res = await ctx._.commands[0].handler({ agent: { session: fakeSession() } })
    expect(res.text).toContain('subagent deadbeef')
    expect(res.text).not.toContain('cafebabe')
  })
  it('exporter only prints turn-doctor lines', () => {
    const ctx = fakeCtx()
    apply(ctx, { providers: {}, keep: 10 })
    const printed = []
    const orig = console.log
    console.log = (l) => printed.push(l)
    try {
      ctx._.exporter.export({ args: ['turn-doctor: hello'] })
      ctx._.exporter.export({ args: ['other-plugin: nope'] })
      ctx._.exporter.export({ args: [42] })
    } finally { console.log = orig }
    expect(printed).toEqual(['turn-doctor: hello'])
  })
})
