/**
 * OAuth 凭据的落盘。
 *
 * ## 为什么是每服务器一个文件
 *
 * 凭据是本插件唯一**不能靠重新推导**恢复的东西：一份坏掉的 JSON 如果装在同一个文件里，
 * 会让全部服务器的授权一起消失，而用户能做的只有逐个重新授权。按服务器名分文件之后，
 * 最坏情况只波及一台。
 *
 * ## 权限
 *
 * 目录 `0700`、文件 `0600`。里面的 `refresh_token` 通常比 `access_token` 长命得多，
 * 拿到它等于长期冒充这个用户 —— 这是本插件唯一持有长期凭据的地方，所以从一开始就锁死，
 * 而不是等出了事再补。
 *
 * ## 不 import 宿主，也不 import SDK
 *
 * 这样它能被直接单测（CI 上没有宿主包），也保证「加密/权限/形状」这些容易出错的部分
 * 与 SDK 版本解耦：SDK 换字段名时，坏的是 provider 的适配层，而不是这份存储。
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 存储格式版本。读到别的版本当作「不可用」而不是猜测。 */
export const STORE_VERSION = 1

/** 单台服务器的凭据文件允许的最大字节数（防御被别的东西写坏的大文件）。 */
const MAX_BYTES = 512 * 1024

/** 服务器名会进文件名，所以要挡掉路径分隔符和一切非常规字符。 */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 服务器名能否安全地当作文件名。
 *
 * `.` 与 `..` 是**保留的路径分量**：它们能通过上面的字符集，但 `join(dir, '.json')` 与
 * `join(dir, '...json')` 的含义取决于操作系统对前导点的处理，而不是我们想要的「文件名」。
 * 这里显式挡掉，因为一个能生成 `..` 的名字意味着调用方拿到了不受信任的输入。
 */
export function isValidServerName(name) {
  if (typeof name !== 'string' || NAME_PATTERN.test(name) !== true) return false
  return name !== '.' && name !== '..'
}

/** 凭据目录。 */
export function oauthDir(dshHome) {
  return join(dshHome, 'dsh-skills-mcp-manager', 'oauth')
}

/** 一台服务器的凭据文件。名字非法时返回空串，调用方据此拒绝而不是落到 `undefined.json`。 */
export function oauthFile(dshHome, serverName) {
  if (!isValidServerName(serverName)) return ''
  return join(oauthDir(dshHome), `${serverName}.json`)
}

/** 一条凭据记录的初始形状。 */
export function emptyRecord(serverName, url) {
  return {
    version: STORE_VERSION,
    serverName,
    url: typeof url === 'string' ? url : '',
    // SDK 的 OAuthClientProvider 回填，原样往返，本模块不解释内容。
    clientInformation: null,
    tokens: null,
    /** 令牌落盘的时刻。SDK 只给相对的 `expires_in`，绝对到期时间要靠它换算。 */
    tokensSavedAt: '',
    discoveryState: null,
    codeVerifier: '',
    resourceUrl: '',
    // 授权进行中的一次性状态：`state` 用于 CSRF 校验，`url` 给面板显示。
    pending: null,
    updatedAt: '',
  }
}

/** 把任意读到的东西收敛成一条记录；形状不对的字段逐个丢掉，而不是整份作废。 */
export function normalizeRecord(raw, serverName, url) {
  const base = emptyRecord(serverName, url)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  // 版本不认识：**保留**旧文件不动，但我们不读它。让用户重新授权，而不是猜结构。
  if (raw.version !== STORE_VERSION) return base
  const record = {
    ...base,
    clientInformation: objectOr(raw.clientInformation, null),
    tokens: objectOr(raw.tokens, null),
    tokensSavedAt: typeof raw.tokensSavedAt === 'string' ? raw.tokensSavedAt : '',
    discoveryState: objectOr(raw.discoveryState, null),
    codeVerifier: typeof raw.codeVerifier === 'string' ? raw.codeVerifier : '',
    resourceUrl: typeof raw.resourceUrl === 'string' ? raw.resourceUrl : '',
    pending: objectOr(raw.pending, null),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
  // 文件里可能记着上一次的 URL；行被改过 URL 时以**行**为准（凭据可能已经不对了）。
  record.url = base.url !== '' ? base.url : (typeof raw.url === 'string' ? raw.url : '')
  return record
}

function objectOr(value, fallback) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

/**
 * 一个绑定到具体 `$DSH_HOME` 的存储。
 *
 * IO 全部可从外部注入，测试因此不需要真的碰磁盘，也不会在 CI 上写出用户目录。
 *
 * @param options.dshHome - 凭据根目录所在的 home。
 * @param options.log - `{ warn }`；本模块**永不抛给调用方**，因为凭据读不出来不该让连接
 *   或面板崩掉 —— 它只应该表现为「这台服务器又需要授权了」。
 */
export function createOAuthStore({ dshHome, log } = {}) {
  const dir = oauthDir(dshHome)

  /** 写一条记录：同目录临时文件 + rename，另加 0600。 */
  const write = async (serverName, record) => {
    const file = oauthFile(dshHome, serverName)
    if (file === '') throw new Error(`服务器名不能用作文件名：${String(serverName)}`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const next = { ...record, version: STORE_VERSION, serverName, updatedAt: new Date().toISOString() }
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
    // rename 保留了临时文件的 inode，mode 已经带过去了；这里再 chmod 一次是因为
    // 有些文件系统（以及 umask 配置异常的机器）不会按创建参数落下权限。
    try {
      await chmod(file, 0o600)
    } catch (error) {
      // 权限收紧失败不该让授权整体失败，但必须留痕：这是安全属性。
      log?.warn?.(`dsh-skills-mcp-manager: 无法把 ${file} 的权限收紧到 0600：${String(error?.message ?? error)}`)
    }
    return next
  }

  return {
    dir,
    file: (serverName) => oauthFile(dshHome, serverName),

    /** 读一条记录；不存在、损坏、名字非法都返回一条空的基线记录。 */
    read: async (serverName, url = '') => {
      const file = oauthFile(dshHome, serverName)
      if (file === '') return emptyRecord(serverName, url)
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return emptyRecord(serverName, url)
      }
      if (text.length > MAX_BYTES) {
        log?.warn?.(`dsh-skills-mcp-manager: 凭据文件 ${file} 过大，已忽略`)
        return emptyRecord(serverName, url)
      }
      let raw
      try {
        raw = JSON.parse(text)
      } catch (error) {
        log?.warn?.(`dsh-skills-mcp-manager: 凭据文件 ${file} 不是合法 JSON：${String(error?.message ?? error)}`)
        return emptyRecord(serverName, url)
      }
      return normalizeRecord(raw, serverName, url)
    },

    /** 读出、改、写回。`mutate` 收到当前记录并返回下一份（可以就地修改）。 */
    update: async (serverName, url, mutate) => {
      const current = await createOAuthStore({ dshHome, log }).read(serverName, url)
      const next = (await mutate(current)) ?? current
      return write(serverName, next)
    },

    /** 直接整份写入（内部用；`update` 已经覆盖日常路径）。 */
    write,

    /**
     * 删掉一台服务器的凭据。
     *
     * 「登出」与「授权失败后重来」都需要它：留着半份凭据，下一次连接会拿着一个
     * 已经作废的 refresh_token 去刷新，错误信息会指向服务器而不是指向这份残留。
     */
    remove: async (serverName) => {
      const file = oauthFile(dshHome, serverName)
      if (file === '') return false
      try {
        await unlink(file)
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        log?.warn?.(`dsh-skills-mcp-manager: 删除凭据 ${file} 失败：${String(error?.message ?? error)}`)
        return false
      }
    },
  }
}
