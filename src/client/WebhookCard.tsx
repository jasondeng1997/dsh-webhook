/**
 * The settings card.
 *
 * A card in this shell is content, not chrome: the surrounding Plugins section
 * supplies the surface, the tab, and the save affordance's frame, and the
 * registrant supplies everything inside. This component therefore renders one
 * self-contained form — the plugin's scalars plus its route list — and nothing
 * else.
 *
 * It renders `null` while the namespace is unavailable. A deployment that does
 * not compose the plugin should show no trace of it rather than a card whose
 * every control would fail.
 *
 * Every service the card needs arrives as a prop: the host-side face through the
 * slot's `inject`, and the translator through the locale seat. Neither is
 * imported, which is what keeps the browser bundle free of runtime dependencies
 * beyond React itself.
 *
 * @module dsh-webhook/client/WebhookCard
 */

import { useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import type { BridgeCardFace, BridgeCardSnapshot, BridgeRouteSettings } from './card-face.ts'
import { interpolate, zh, type WebhookLocaleKey } from './locales.ts'

/** Props the slot system hands this card. */
export interface WebhookCardProps {
  /** The host-side state face. */
  bridge?: BridgeCardFace
  /** Translator bound to this card's namespace; absent when the shell supplies none. */
  t?: (key: string, params?: Record<string, unknown>) => string
  /** Active locale id, when the shell forwards it. */
  locale?: string
  /** Slot store hook, unused by this card but passed by the slot machinery. */
  useStore?: unknown
}

const styles = {
  card: {
    display: 'grid',
    gap: '14px',
    padding: '14px 16px',
    border: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35))',
    borderRadius: '8px',
    fontSize: '13px',
  } satisfies CSSProperties,
  header: { display: 'grid', gap: '2px' } satisfies CSSProperties,
  title: { fontWeight: 600, fontSize: '14px' } satisfies CSSProperties,
  hint: { opacity: 0.7, fontSize: '12px', lineHeight: 1.5 } satisfies CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '10px 14px',
  } satisfies CSSProperties,
  field: { display: 'grid', gap: '4px' } satisfies CSSProperties,
  label: { fontSize: '12px', opacity: 0.85 } satisfies CSSProperties,
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '4px',
    border: '1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.4))',
    background: 'var(--vscode-input-background, transparent)',
    color: 'inherit',
    font: 'inherit',
  } satisfies CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: '8px' } satisfies CSSProperties,
  route: {
    display: 'grid',
    gap: '8px',
    padding: '10px 12px',
    border: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25))',
    borderRadius: '6px',
  } satisfies CSSProperties,
  routeHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } satisfies CSSProperties,
  button: {
    padding: '4px 10px',
    borderRadius: '4px',
    border: '1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.4))',
    background: 'var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.12))',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  } satisfies CSSProperties,
  primary: {
    padding: '5px 14px',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #ffffff)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  } satisfies CSSProperties,
  warn: { color: 'var(--vscode-editorWarning-foreground, #d18616)', fontSize: '12px' } satisfies CSSProperties,
  error: { color: 'var(--vscode-errorForeground, #f14c4c)', fontSize: '12px' } satisfies CSSProperties,
  actions: { display: 'flex', alignItems: 'center', gap: '10px' } satisfies CSSProperties,
}

/** Coerce an incoming value to a trimmed comma-separated list. */
function toList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/**
 * Render the card.
 * @param props - slot props carrying the host face and the translator.
 * @returns the settings card, or nothing while the namespace is unavailable.
 */
export function WebhookCard(props: WebhookCardProps): ReactElement | null {
  const face = props.bridge ?? (props as unknown as BridgeCardFace)
  const t = useMemo(() => {
    // The shell supplies `t` from its locale registry. Falling back to the
    // bundled dictionary keeps the card readable if a shell version hands a slot
    // content component no translator; raw keys never reach a user.
    const translate = typeof props.t === 'function' ? props.t : undefined
    return (key: WebhookLocaleKey, params?: Record<string, unknown>): string => {
      const fallback = zh[key] ?? String(key)
      const text = translate === undefined ? fallback : (translate(key, params) || fallback)
      return params === undefined ? text : interpolate(text, params)
    }
  }, [props.t])

  const store = useMemo(
    () => ({
      subscribe: (listener: () => void) => face.subscribe(listener),
      getSnapshot: () => face.getSnapshot(),
    }),
    [face],
  )
  const snapshot: BridgeCardSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [newPath, setNewPath] = useState('')

  if (snapshot.status === 'unavailable') return null

  if (snapshot.status === 'loading' || snapshot.draft === undefined) {
    return (
      <div style={styles.card}>
        <div style={styles.title}>{t('card.title')}</div>
        <div style={styles.hint}>{t('status.loading')}</div>
      </div>
    )
  }

  const draft = snapshot.draft
  const dirtyCount = snapshot.dirtyFields.length
  const canWrite = snapshot.writable

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>{t('card.title')}</div>
        <div style={styles.hint}>{t('card.description')}</div>
        {!canWrite && <div style={styles.warn}>{t('status.readonly')}</div>}
      </div>

      <div style={styles.grid}>
        <label style={styles.field}>
          <span style={styles.label}>{t('field.enabled')}</span>
          <span style={styles.row}>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={!canWrite}
              onChange={(event) => { face.stageScalar('enabled', event.target.checked) }}
            />
            <span style={styles.hint}>{t('field.enabled.hint')}</span>
          </span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('field.host')}</span>
          <input
            style={styles.input}
            value={draft.host}
            disabled={!canWrite}
            onChange={(event) => { face.stageScalar('host', event.target.value) }}
          />
          <span style={styles.hint}>{t('field.host.hint')}</span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('field.port')}</span>
          <input
            style={styles.input}
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            disabled={!canWrite}
            onChange={(event) => { face.stageScalar('port', Number(event.target.value)) }}
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('field.sendTool')}</span>
          <span style={styles.row}>
            <input
              type="checkbox"
              checked={draft.sendTool}
              disabled={!canWrite}
              onChange={(event) => { face.stageScalar('sendTool', event.target.checked) }}
            />
            <span style={styles.hint}>{t('field.sendTool.hint')}</span>
          </span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('field.sendToolAllowHosts')}</span>
          <input
            style={styles.input}
            value={draft.sendToolAllowHosts.join(', ')}
            disabled={!canWrite || !draft.sendTool}
            onChange={(event) => { face.stageScalar('sendToolAllowHosts', toList(event.target.value)) }}
          />
          <span style={styles.hint}>{t('field.sendToolAllowHosts.hint')}</span>
        </label>
      </div>

      <div style={styles.header}>
        <div style={styles.title}>{t('routes.title')}</div>
        {draft.routes.length === 0 && <div style={styles.hint}>{t('routes.empty')}</div>}
      </div>

      {draft.routes.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          disabled={!canWrite}
          t={t}
          onPatch={(patch) => { face.stageRoute(route.id, patch) }}
          onRemove={() => { face.stageRemoveRoute(route.id) }}
          removeLabel={t('routes.remove')}
        />
      ))}

      <div style={styles.actions}>
        <input
          style={{ ...styles.input, maxWidth: '260px' }}
          placeholder={t('routes.newPath')}
          value={newPath}
          disabled={!canWrite}
          onChange={(event) => { setNewPath(event.target.value) }}
        />
        <button
          type="button"
          style={styles.button}
          disabled={!canWrite}
          onClick={() => {
            face.stageAddRoute(newPath)
            setNewPath('')
          }}
        >
          {t('routes.add')}
        </button>
      </div>

      {snapshot.error !== undefined && (
        <div style={styles.error}>{t('error.title')}: {snapshot.error}</div>
      )}

      <div style={styles.actions}>
        <button
          type="button"
          style={canWrite && dirtyCount > 0 ? styles.primary : { ...styles.primary, opacity: 0.5 }}
          disabled={!canWrite || dirtyCount === 0 || snapshot.saving}
          onClick={() => { void face.save() }}
        >
          {snapshot.saving ? t('action.saving') : t('action.save')}
        </button>
        <button
          type="button"
          style={styles.button}
          disabled={!canWrite || dirtyCount === 0 || snapshot.saving}
          onClick={() => { face.discard() }}
        >
          {t('action.discard')}
        </button>
        {dirtyCount > 0 && <span style={styles.hint}>{t('dirty.count', { count: dirtyCount })}</span>}
      </div>
    </div>
  )
}

/** One route's editor. */
function RouteRow(props: {
  route: BridgeRouteSettings
  disabled: boolean
  t: (key: WebhookLocaleKey, params?: Record<string, unknown>) => string
  onPatch: (patch: Partial<BridgeRouteSettings>) => void
  onRemove: () => void
  removeLabel: string
}): ReactElement {
  const { route, disabled, t, onPatch, onRemove, removeLabel } = props
  const unsignedWithoutSecret = route.secretRef === '' && !route.allowUnsigned
  return (
    <div style={styles.route}>
      <div style={styles.routeHead}>
        <span style={styles.label}>{t('route.id')}: <code>{route.id}</code></span>
        <span style={styles.row}>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={route.enabled}
              disabled={disabled}
              onChange={(event) => { onPatch({ enabled: event.target.checked }) }}
            />
            <span style={styles.label}>{t('route.enabled')}</span>
          </label>
          <button type="button" style={styles.button} disabled={disabled} onClick={onRemove}>
            {removeLabel}
          </button>
        </span>
      </div>

      <div style={styles.grid}>
        <label style={styles.field}>
          <span style={styles.label}>{t('route.path')}</span>
          <input
            style={styles.input}
            value={route.path}
            disabled={disabled}
            onChange={(event) => { onPatch({ path: event.target.value }) }}
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.source')}</span>
          <select
            style={styles.input}
            value={route.source}
            disabled={disabled}
            onChange={(event) => { onPatch({ source: event.target.value as BridgeRouteSettings['source'] }) }}
          >
            <option value="generic">generic</option>
            <option value="github">github</option>
            <option value="gitlab">gitlab</option>
            <option value="gitee">gitee</option>
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.secretRef')}</span>
          <input
            style={styles.input}
            value={route.secretRef}
            disabled={disabled}
            placeholder="GITHUB_WEBHOOK_SECRET"
            onChange={(event) => { onPatch({ secretRef: event.target.value }) }}
          />
          <span style={styles.hint}>{t('route.secretRef.hint')}</span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.session')}</span>
          <input
            style={styles.input}
            value={route.session}
            disabled={disabled}
            onChange={(event) => { onPatch({ session: event.target.value }) }}
          />
          <span style={styles.hint}>{t('route.session.hint')}</span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.events')}</span>
          <input
            style={styles.input}
            value={route.events.join(', ')}
            disabled={disabled}
            placeholder="push, pull_request"
            onChange={(event) => { onPatch({ events: toList(event.target.value) }) }}
          />
          <span style={styles.hint}>{t('route.events.hint')}</span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.callbackUrl')}</span>
          <input
            style={styles.input}
            value={route.callbackUrl}
            disabled={disabled}
            placeholder="https://example.com/dsh/reply"
            onChange={(event) => { onPatch({ callbackUrl: event.target.value }) }}
          />
          <span style={styles.hint}>{t('route.callbackUrl.hint')}</span>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.maxConcurrency')}</span>
          <input
            style={styles.input}
            type="number"
            min={1}
            max={32}
            value={route.maxConcurrency}
            disabled={disabled}
            onChange={(event) => { onPatch({ maxConcurrency: Number(event.target.value) }) }}
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('route.template')}</span>
          <textarea
            style={{ ...styles.input, minHeight: '64px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
            value={route.template}
            disabled={disabled}
            placeholder={'A {{ __source }} delivery arrived.\n\n{{ json }}'}
            onChange={(event) => { onPatch({ template: event.target.value }) }}
          />
          <span style={styles.hint}>{t('route.template.hint')}</span>
        </label>
      </div>

      <label style={styles.row}>
        <input
          type="checkbox"
          checked={route.allowUnsigned}
          disabled={disabled}
          onChange={(event) => { onPatch({ allowUnsigned: event.target.checked }) }}
        />
        <span style={route.allowUnsigned ? styles.warn : styles.label}>
          {t('route.allowUnsigned')}
          {route.allowUnsigned ? ` — ${t('route.allowUnsigned.warning')}` : ''}
        </span>
      </label>

      {unsignedWithoutSecret && <div style={styles.warn}>{t('route.secretRef.hint')}</div>}
    </div>
  )
}
