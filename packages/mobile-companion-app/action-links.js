const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * PWA 只登记自身首页；原生客户端可以用同样的 targetId 契约扩展自己的目录。
 * 非 HTTPS 页面只有 loopback 开发地址可以进入目录，避免把普通局域网 HTTP 当成可信目标。
 */
export function registeredLinkTargets(baseHref) {
  let base;
  try { base = new URL(baseHref); } catch { return Object.freeze({}); }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname))) return Object.freeze({});
  return Object.freeze({ 'companion-home': new URL('./', base).href });
}

export function resolveRegisteredLink(targetId, baseHref) {
  const targets = registeredLinkTargets(baseHref);
  if (typeof targetId !== 'string' || !Object.hasOwn(targets, targetId)) throw new Error('链接目标未在手机端登记');
  return targets[targetId];
}
