import { describe, it, expect } from 'vitest'
import { name } from '../src/index.js'

describe('scaffolding', () => {
  it('exports the plugin name', () => {
    expect(name).toBe('turn-doctor')
  })
})
