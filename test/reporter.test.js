import { describe, it, expect } from 'vitest'
import { createReporter } from '../src/index.js'
import { fakeCtx, fakeSession } from './helpers.js'

describe('reporter', () => {
  it('logs, remembers, appends', () => {
    const ctx = fakeCtx(); const session = fakeSession()
    const rep = createReporter(ctx, { keep: 2 }, () => 42)
    rep.report(session, { layer: 'undici-body', confidence: 'timing', verdict: 'v', evidence: 'e', hint: 'h',
      kind: 'model', turn: 7, attempt: 1, terminal: true, failure: { code: 'TRANSPORT', message: 'terminated' } })
    const line = ctx._.logs.find(l => String(l[1]).startsWith('turn-doctor:'))
    expect(line[1]).toContain('turn 7')
    expect(line[1]).toContain('(terminal)')
    expect(line[1]).toContain('verdict: v')
    expect(session.appended[0].type).toBe('turn-doctor/verdict')
    expect(session.appended[0].data.at).toBe(42)
    expect(rep.list(session.id)).toHaveLength(1)
  })
  it('ring buffer caps at keep', () => {
    const ctx = fakeCtx(); const session = fakeSession()
    const rep = createReporter(ctx, { keep: 2 }, () => 0)
    for (let i = 0; i < 5; i++) rep.report(session, { layer: 'l' + i, verdict: 'v', evidence: 'e', hint: 'h', kind: 'model' })
    expect(rep.list(session.id).map(v => v.layer)).toEqual(['l3', 'l4'])
  })
  it('append failure does not stop the terminal line', () => {
    const ctx = fakeCtx()
    const session = { ...fakeSession(), append: () => { throw new Error('disposed') } }
    const rep = createReporter(ctx, { keep: 2 }, () => 0)
    expect(() => rep.report(session, { layer: 'x', verdict: 'v', evidence: 'e', hint: 'h', kind: 'model' })).not.toThrow()
    expect(ctx._.logs.length).toBeGreaterThan(0)
  })
})
