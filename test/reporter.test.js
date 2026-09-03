import { describe, it, expect } from 'vitest'
import { createReporter } from '../src/index.js'
import { fakeCtx, fakeSession, fakeSessionAlpha } from './helpers.js'

describe('reporter', () => {
  it('logs and remembers, never writes to the session log', () => {
    const ctx = fakeCtx(); const session = fakeSession()
    const rep = createReporter(ctx, { keep: 2 }, () => 42)
    rep.report(session, { layer: 'undici-body', confidence: 'timing', verdict: 'v', evidence: 'e', hint: 'h',
      kind: 'model', turn: 7, attempt: 1, terminal: true, failure: { code: 'TRANSPORT', message: 'terminated' } })
    const line = ctx._.logs.find(l => String(l[1]).startsWith('turn-doctor:'))
    expect(line[1]).toContain('turn 7')
    expect(line[1]).toContain('(terminal)')
    expect(line[1]).toContain('verdict: v')
    // A custom event type in the durable log makes dsh refuse to load the session later.
    expect(session.appended).toHaveLength(0)
    expect(rep.list(session.id)).toHaveLength(1)
    expect(rep.list(session.id)[0].at).toBe(42)
  })
  it('ring buffer caps at keep', () => {
    const ctx = fakeCtx(); const session = fakeSession()
    const rep = createReporter(ctx, { keep: 2 }, () => 0)
    for (let i = 0; i < 5; i++) rep.report(session, { layer: 'l' + i, verdict: 'v', evidence: 'e', hint: 'h', kind: 'model' })
    expect(rep.list(session.id).map(v => v.layer)).toEqual(['l3', 'l4'])
  })
  it('needs neither append nor events from the session (dsh 0.1.2 shape)', () => {
    const ctx = fakeCtx()
    const session = fakeSessionAlpha()
    const rep = createReporter(ctx, { keep: 2 }, () => 0)
    expect(() => rep.report(session, { layer: 'x', verdict: 'v', evidence: 'e', hint: 'h', kind: 'model' })).not.toThrow()
    expect(ctx._.logs.length).toBeGreaterThan(0)
    expect(rep.list(session.id)).toHaveLength(1)
  })
})
