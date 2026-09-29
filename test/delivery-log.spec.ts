/**
 * Delivery log tests.
 *
 * The log is the only diagnostic surface the bridge exposes over HTTP, so its
 * eviction and update behaviour is pinned: a record that has been evicted must
 * not be silently resurrected by a late update.
 */

import { describe, expect, it } from 'vitest'
import { DeliveryLog } from '../src/delivery-log.ts'

/** A minimal record for the given id. */
const record = (id: string, stage: 'queued' | 'answered' = 'queued'): Parameters<DeliveryLog['add']>[0] => ({
  id,
  route: 'ci',
  source: 'github',
  receivedAt: '2026-09-29T00:00:00.000Z',
  stage,
})

describe('DeliveryLog', () => {
  it('returns recent records newest first', () => {
    const log = new DeliveryLog(10)
    log.add(record('a'))
    log.add(record('b'))
    expect(log.recent().map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('honors the limit while never exceeding the buffer', () => {
    const log = new DeliveryLog(3)
    for (const id of ['a', 'b', 'c']) log.add(record(id))
    expect(log.recent(2).map((entry) => entry.id)).toEqual(['c', 'b'])
    expect(log.recent(0)).toEqual([])
    expect(log.recent(-1)).toEqual([])
  })

  it('evicts the oldest record and forgets it', () => {
    const log = new DeliveryLog(2)
    log.add(record('a'))
    log.add(record('b'))
    log.add(record('c'))
    expect(log.recent().map((entry) => entry.id)).toEqual(['c', 'b'])
    expect(log.get('a')).toBeUndefined()
    expect(log.update('a', { stage: 'answered' })).toBeUndefined()
  })

  it('updates a retained record in place', () => {
    const log = new DeliveryLog(5)
    log.add(record('a'))
    const updated = log.update('a', { stage: 'answered', durationMs: 12, detail: 'done' })
    expect(updated?.stage).toBe('answered')
    expect(log.get('a')?.durationMs).toBe(12)
  })

  it('drops everything when the capacity is zero', () => {
    const log = new DeliveryLog(0)
    log.add(record('a'))
    expect(log.recent()).toEqual([])
    expect(log.summary()).toEqual({ total: 0, byStage: {} })
  })

  it('summarizes stages for the health response', () => {
    const log = new DeliveryLog(10)
    log.add(record('a', 'queued'))
    log.add(record('b', 'answered'))
    log.add(record('c', 'answered'))
    expect(log.summary()).toEqual({ total: 3, byStage: { queued: 1, answered: 2 } })
  })
})
