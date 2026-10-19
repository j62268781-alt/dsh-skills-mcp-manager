/**
 * `state` 的定长比较。
 *
 * ## 为什么单独一个文件
 *
 * 这是本插件唯一**安全关键**的比较：`/oauth/callback` 挂在 DSH 自己的监听端口上，
 * 任何能访问那个端口的东西都能往它发一个 `?code=…&state=…`。`state` 是唯一能证明
 * 「这次回调属于我刚刚发起的那一轮」的证据。
 *
 * 两个细节都会静默失效，所以必须钉住：
 *
 * 1. **定长比较**。`===` 会在第一个不同字节处提前返回，攻击者能据此逐字节猜出期望值。
 *    `timingSafeEqual` 要求两段长度相等，否则**直接抛错** —— 所以长度不等时必须先自己
 *    返回 false，不能让它抛（抛出去会变成一个 500，看起来像插件坏了）。
 * 2. **UTF-8 字节长度，不是字符数**。`state` 是 base64url（纯 ASCII），但收到的值来自
 *    网络、可能包含任意 Unicode；用 `String.length` 比较会在多字节字符上得到错误的
 *    「长度相等」，然后 `timingSafeEqual` 抛错。
 *
 * 不 import 宿主、不 import SDK —— 纯函数，可直接单测。
 */
import { timingSafeEqual } from 'node:crypto'

/**
 * 两个 `state` 是否相等，且比较耗时与内容无关。
 *
 * @param expected - 服务端存下的期望值。
 * @param received - 回调 query 里收到的值。
 * @returns 严格相等时为 true；任何非字符串、空串、长度不同都为 false（不抛错）。
 */
export function stateMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false
  if (expected === '' || received === '') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(received, 'utf8')
  // 长度不等直接 false：喂给 timingSafeEqual 会抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，
  // 那是异常路径而不是「不相等」，会把一次伪造回调变成一次 500。
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    // 防御：理论上只有长度不等才会到这里，而上面已经挡了。
    return false
  }
}

/** 生成一个 32 字节的 base64url 随机值（`state` 与 PKCE verifier 都用得上）。 */
export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes)
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues !== undefined) {
    cryptoApi.getRandomValues(buffer)
  } else {
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.floor(Math.random() * 256)
  }
  return Buffer.from(buffer).toString('base64url')
}

/** 回调 query 里 `state` / `code` 是否都恰好出现一次（重复参数一律拒绝）。 */
export function singleParams(searchParams) {
  const states = searchParams.getAll('state')
  const codes = searchParams.getAll('code')
  const errors = searchParams.getAll('error')
  return {
    ok: states.length === 1 && codes.length === 1 && errors.length === 0,
    state: states.length === 1 ? states[0] : '',
    code: codes.length === 1 ? codes[0] : '',
    error: errors.length === 1 ? errors[0] : '',
    errorDescription: (searchParams.getAll('error_description')[0] ?? ''),
  }
}
