export const DOWNLINK_NONCE_TTL_MS = 5 * 60_000;
export const DOWNLINK_NONCE_LIMIT = 256;

/** 保留完整协议时间窗内的 nonce；容量不足时失败关闭，不能靠挤掉旧值降低防重放保障。 */
export function rememberDownlinkNonce(nonces, value, acceptedAt) {
  for (const [nonce, seenAt] of nonces) {
    const age = acceptedAt - seenAt;
    if (age > DOWNLINK_NONCE_TTL_MS) nonces.delete(nonce);
    else if (age < -DOWNLINK_NONCE_TTL_MS) throw new Error('手机动作防重放时钟异常，请重新连接');
  }
  if (nonces.has(value)) throw new Error('手机动作下行包重复');
  if (nonces.size >= DOWNLINK_NONCE_LIMIT) throw new Error('手机动作防重放窗口已满，请重新连接');
  nonces.set(value, acceptedAt);
}
