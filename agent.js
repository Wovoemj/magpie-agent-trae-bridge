/**
 * Magpie agent entry (`magpie.agent`). Magpie evaluates THIS file in a small
 * sandbox with no Node APIs and no imports beyond files beside it, so it stays
 * pure data: the descriptor, and a `connect()` that answers at once. All the
 * real work (patching Trae's chat bundle, running the catalogue daemon) is done
 * by `plugin.js`, which the OpenCode host loads in Bun with full Node access.
 */
export const agent = {
  id: 'trae-bridge',
  name: 'Trae · Magpie Bridge',
  config: '~/.config/magpie-trae-bridge/connection.json',
  format: 'json',
  model: 'model',
  ua: ['trae-magpie-bridge'],
  notice:
    '打开开关即可把 Magpie 的全部模型与路由组写进 Trae 的模型菜单，Trae 的登录与账号不受影响。' +
    '首次会自动接管 Trae 的对话面板（约几秒）；接管完成后重启一次 Trae，模型菜单里就能看到 Magpie 的模型。',
};

export function connect({ gateway, model, models } = {}) {
  const gw = typeof gateway === 'string' ? gateway : gateway?.v1 || gateway?.url;
  const key = typeof gateway === 'object' ? gateway?.key : undefined;
  return {
    enabled: true,
    gateway: gw,
    key,
    model: model || undefined,
    models: (models || []).map((m) => ({ id: m.id, name: m.name || m.id, context: m.context || null })),
  };
}

export function disconnect() {
  return { enabled: false };
}

export default agent;
