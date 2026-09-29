/**
 * Card dictionaries.
 *
 * The card ships both languages and lets the shell's locale registry pick, so a
 * deployment switched to English shows English copy without a restart. Chinese is
 * the fallback: any key missing from the host's active language renders from the
 * `zh` map rather than showing a raw key to a user.
 *
 * @module dsh-webhook/client/locales
 */

/** Namespace registered with the locale service; also the settings namespace. */
export const NS = 'dsh-webhook' as const

/** Simplified Chinese copy. */
export const zh = {
  'card.title': 'Webhook 桥',
  'card.description': '把外部 HTTP Webhook 变成 Agent 会话输入，并把回答回传到你的端点。',

  'status.loading': '正在读取配置…',
  'status.unavailable': '该部署没有加载 dsh-webhook 的配置命名空间，此卡片不显示任何内容。',
  'status.readonly': '当前连接只能读取配置；请在 Host 上修改 profile 的配置文件。',
  'status.ready': '配置已同步。',

  'field.enabled': '启用插件',
  'field.enabled.hint': '关闭后插件不再监听端口，已有路由全部停止接收投递。',
  'field.host': '监听地址',
  'field.host.hint': '默认 127.0.0.1 只接受本机投递；改为 0.0.0.0 会暴露到网络。',
  'field.port': '监听端口',
  'field.sendTool': '注册出站工具',
  'field.sendTool.hint': '启用后模型可以调用 webhook_send 主动向外部推送消息。',
  'field.sendToolAllowHosts': '出站白名单',
  'field.sendToolAllowHosts.hint': '逗号分隔。留空表示不限制主机；以 . 开头表示该域名及其子域。',

  'routes.title': '投递路由',
  'routes.empty': '还没有配置任何路由。添加一条路由后，把上游 Webhook 指向 http://地址:端口/路径。',
  'routes.add': '添加路由',
  'routes.remove': '移除',
  'routes.newPath': '新路由路径',

  'route.id': '路由 ID',
  'route.path': '路径',
  'route.source': '上游类型',
  'route.enabled': '启用',
  'route.secretRef': '密钥引用',
  'route.secretRef.hint': '填写凭据库中的环境变量名，例如 GITHUB_WEBHOOK_SECRET。密钥内容不会回传到浏览器。',
  'route.session': '会话',
  'route.session.hint': 'auto 表示该路由首次投递时自动创建一个会话并复用；也可以填入已有会话 ID。',
  'route.template': '提示词模板',
  'route.template.hint': '支持 {{ 路径 }} 占位符，例如 {{ repository.full_name }}；{{ json }} 为完整载荷。留空使用内置模板。',
  'route.events': '事件过滤',
  'route.events.hint': '逗号分隔，仅投递这些事件；留空表示全部。',
  'route.callbackUrl': '回传地址',
  'route.callbackUrl.hint': 'Agent 回答后 POST 到此地址；留空则只在会话中留存回答。',
  'route.allowUnsigned': '允许无签名投递',
  'route.allowUnsigned.warning': '危险：任何能访问该端口的人都可以驱动这个会话。',
  'route.maxConcurrency': '并发上限',

  'action.save': '保存',
  'action.discard': '放弃修改',
  'action.saving': '正在保存…',
  'dirty.count': '有 {count} 处未保存的修改',

  'error.title': '保存失败',
  'unsaved.leave': '仍有未保存的修改。',
} as const

/** English copy. */
export const en: Record<keyof typeof zh, string> = {
  'card.title': 'Webhook bridge',
  'card.description': 'Turn inbound HTTP webhooks into agent turns, and post the answer back to your endpoint.',

  'status.loading': 'Reading configuration…',
  'status.unavailable': 'This deployment does not compose the dsh-webhook settings namespace, so the card renders nothing.',
  'status.readonly': 'This connection can only read configuration; edit the profile configuration file on the host.',
  'status.ready': 'Configuration is in sync.',

  'field.enabled': 'Enable the plugin',
  'field.enabled.hint': 'When off, no port is opened and every route stops accepting deliveries.',
  'field.host': 'Listen address',
  'field.host.hint': '127.0.0.1 accepts local deliveries only; 0.0.0.0 exposes the port to the network.',
  'field.port': 'Listen port',
  'field.sendTool': 'Register the outbound tool',
  'field.sendTool.hint': 'Lets the model call webhook_send to push messages outward.',
  'field.sendToolAllowHosts': 'Outbound allowlist',
  'field.sendToolAllowHosts.hint': 'Comma separated. Empty allows any host; a leading dot covers a domain and its subdomains.',

  'routes.title': 'Delivery routes',
  'routes.empty': 'No route is configured yet. Add one, then point the upstream webhook at http://address:port/path.',
  'routes.add': 'Add route',
  'routes.remove': 'Remove',
  'routes.newPath': 'New route path',

  'route.id': 'Route id',
  'route.path': 'Path',
  'route.source': 'Upstream',
  'route.enabled': 'Enabled',
  'route.secretRef': 'Secret reference',
  'route.secretRef.hint': 'Name of a stored credential, e.g. GITHUB_WEBHOOK_SECRET. The secret itself never reaches the browser.',
  'route.session': 'Session',
  'route.session.hint': 'auto creates one session on the first delivery and reuses it; otherwise an existing session id.',
  'route.template': 'Prompt template',
  'route.template.hint': 'Supports {{ path }} placeholders such as {{ repository.full_name }}; {{ json }} is the whole payload. Empty uses the built-in template.',
  'route.events': 'Event filter',
  'route.events.hint': 'Comma separated; only these events are delivered. Empty delivers all.',
  'route.callbackUrl': 'Callback URL',
  'route.callbackUrl.hint': 'Where the agent answer is posted; empty keeps the answer in the session only.',
  'route.allowUnsigned': 'Accept unsigned deliveries',
  'route.allowUnsigned.warning': 'Dangerous: anyone who can reach this port can drive this session.',
  'route.maxConcurrency': 'Concurrency',

  'action.save': 'Save',
  'action.discard': 'Discard',
  'action.saving': 'Saving…',
  'dirty.count': '{count} unsaved change(s)',

  'error.title': 'Save failed',
  'unsaved.leave': 'There are unsaved changes.',
}

/** The card's locale key type. */
export type WebhookLocaleKey = keyof typeof zh

/** Run one `{name}` interpolation over a dictionary entry. */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}
