/**
 * Bounded in-memory delivery log.
 *
 * The bridge needs a diagnostic surface that answers "did the delivery arrive,
 * and what happened next" without a database. The log keeps the last N records
 * in a ring buffer and is deliberately trim: no raw payloads (they may carry
 * tokens), no headers, no secrets — only the identity of a delivery, the stage
 * it reached, and the failure text the bridge produced itself.
 *
 * @module dsh-webhook/delivery-log
 */

/** Stage a delivery reached. */
export type DeliveryStage =
  | 'received'
  | 'rejected'
  | 'filtered'
  | 'queued'
  | 'prompted'
  | 'answered'
  | 'timeout'
  | 'callback-failed'
  | 'failed'

/** One delivery's record. */
export interface DeliveryRecord {
  /** Id minted at receipt. */
  id: string
  /** Route that accepted the delivery. */
  route: string
  /** Upstream service name. */
  source: string
  /** Event name, when the upstream reported one. */
  event?: string
  /** ISO-8601 receipt timestamp. */
  receivedAt: string
  /** Last stage reached. */
  stage: DeliveryStage
  /** Session the delivery drove, once known. */
  sessionId?: string
  /** Milliseconds between receipt and the terminal stage. */
  durationMs?: number
  /** Short, bridge-authored explanation for a non-happy stage. */
  detail?: string
  /** Placeholder paths the template could not resolve. */
  missing?: string[]
}

/** Ring buffer over delivery records. */
export class DeliveryLog {
  private readonly records: DeliveryRecord[] = []
  private readonly byId = new Map<string, DeliveryRecord>()

  /**
   * @param capacity - how many records to retain; `0` disables the log.
   */
  constructor(private readonly capacity: number) {}

  /** Append a record, evicting the oldest when the buffer is full. */
  add(record: DeliveryRecord): void {
    if (this.capacity <= 0) return
    this.records.push(record)
    this.byId.set(record.id, record)
    while (this.records.length > this.capacity) {
      const evicted = this.records.shift()
      if (evicted !== undefined) this.byId.delete(evicted.id)
    }
  }

  /**
   * Update one record in place.
   * @param id - delivery id.
   * @param patch - fields to merge into the record.
   * @returns the updated record, or `undefined` when it has been evicted.
   */
  update(id: string, patch: Partial<DeliveryRecord>): DeliveryRecord | undefined {
    const record = this.byId.get(id)
    if (record === undefined) return undefined
    Object.assign(record, patch)
    return record
  }

  /** One record by id. */
  get(id: string): DeliveryRecord | undefined {
    return this.byId.get(id)
  }

  /** Most recent records, newest first. */
  recent(limit = 50): DeliveryRecord[] {
    const size = Math.max(0, Math.min(this.records.length, Math.trunc(limit)))
    if (size === 0) return []
    return this.records.slice(this.records.length - size).reverse()
  }

  /** Aggregated counters, cheap enough for a health response. */
  summary(): { total: number; byStage: Record<string, number> } {
    const byStage: Record<string, number> = {}
    for (const record of this.records) {
      byStage[record.stage] = (byStage[record.stage] ?? 0) + 1
    }
    return { total: this.records.length, byStage }
  }
}
