/**
 * Plugin version, kept in one place so the health endpoint, the boot log, and
 * the `webhook_send` tool's description agree. A test asserts this matches
 * `package.json`, so a release cannot drift out of sync with what it reports.
 *
 * @module dsh-webhook/version
 */

/** The running plugin version. */
export const VERSION = '0.1.2'

/** Settings namespace shared by the host section and the browser card. */
export const SETTINGS_NAMESPACE = 'dsh-webhook'
