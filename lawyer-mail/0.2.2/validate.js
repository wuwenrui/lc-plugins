/**
 * 邮件插件校验与清洗纯逻辑（不依赖 cordis / dsh 包，不发网络请求）。
 *
 * 三块职责，全部 fail-loud（错误抛 MailArgsError / MailPolicyError）：
 * 1. 账号与主机：邮箱地址、主机名、端口、加密方式的合法性；明文连接与私网地址策略；
 * 2. IMAP 查询：文件夹名、UID、搜索关键字的规范化，并**拒绝注入**（CR/LF/NUL 一律拦下，
 *    引号与反斜杠按 IMAP quoted-string 转义，日期时间只接受可解析输入后重排为标准格式）；
 * 3. 附件落盘：文件名清洗（去路径、去控制字符、去 Windows 保留名）、类型黑名单
 *    （可执行/脚本默认拒收）、目标路径必须落在配置的保存根目录内（防目录穿越）。
 */

import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { MailArgsError, MailFileError, MailPolicyError } from './errors.js'

/** 已知邮箱服务商预设（主机 + 端口 + 加密），绑定时可只报 provider 省去手填。 */
export const PROVIDER_PRESETS = Object.freeze({
  qq: { label: 'QQ 邮箱', imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } },
  '163': { label: '网易 163 邮箱', imap: { host: 'imap.163.com', port: 993, secure: true }, smtp: { host: 'smtp.163.com', port: 465, secure: true } },
  '126': { label: '网易 126 邮箱', imap: { host: 'imap.126.com', port: 993, secure: true }, smtp: { host: 'smtp.126.com', port: 465, secure: true } },
  '139': { label: '中国移动 139 邮箱', imap: { host: 'imap.139.com', port: 993, secure: true }, smtp: { host: 'smtp.139.com', port: 465, secure: true } },
  outlook: { label: 'Outlook / Hotmail', imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  gmail: { label: 'Gmail（需应用专用密码）', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  exmail: { label: '腾讯企业邮', imap: { host: 'imap.exmail.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true } },
})

/** 默认附件保存根目录名（相对产品数据目录下的用户 Workspace 根时由配置覆盖）。 */
export const DEFAULT_ATTACHMENT_DIR_NAME = 'mail-attachments'

/** 默认单附件上限：25MB（多数邮箱服务商的单封上限，超过即拒收而不是截断）。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** 危险附件扩展名：与主程序同机的可执行/脚本/快捷方式，默认一律拒收。 */
export const BLOCKED_ATTACHMENT_EXTENSIONS = Object.freeze([
  '.exe', '.msi', '.msp', '.com', '.scr', '.pif', '.cpl', '.dll', '.sys', '.bat', '.cmd',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk',
  '.reg', '.chm', '.hta', '.app', '.command', '.sh', '.run', '.apk', '.dmg', '.pkg', '.deb', '.rpm',
])

/** Windows 保留设备名（大小写不敏感，含带扩展名形式）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** modified UTF-7 里 base64 段的转义字符：IMAP 用 `,` 代替 `\`... 实为代替 `/`。 */
function base64EncodeCodeUnits(codeUnits) {
  const bytes = Buffer.alloc(codeUnits.length * 2)
  codeUnits.forEach((unit, index) => bytes.writeUInt16BE(unit, index * 2))
  return bytes.toString('base64').replace(/=+$/, '').replaceAll('/', ',')
}

function base64DecodeToCodeUnits(payload) {
  const normalized = payload.replaceAll(',', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const bytes = Buffer.from(padded, 'base64')
  const units = []
  for (let index = 0; index + 1 < bytes.length; index += 2) units.push(bytes.readUInt16BE(index))
  return units
}

/**
 * IMAP 邮箱名（modified UTF-7，RFC 3501 §5.1.3）：非 ASCII 段编成 `&<b64>-`。
 * 真实服务商（QQ/163/Gmail）都用这一形式；直接发裸 UTF-8 会被判「邮箱不存在」。
 * 纯 ASCII 名（含 INBOX）原样返回。
 */
export function encodeMailboxName(name) {
  const text = String(name ?? '')
  let out = ''
  let pending = []
  const flush = () => {
    if (pending.length === 0) return
    out += `&${base64EncodeCodeUnits(pending)}-`
    pending = []
  }
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 0x20 && code <= 0x7e) {
      flush()
      out += char === '&' ? '&-' : char
      continue
    }
    // 代理对拆成两个 UTF-16 码元（modified UTF-7 就是按码元编码）
    if (code > 0xffff) {
      const offset = code - 0x10000
      pending.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
      continue
    }
    pending.push(code)
  }
  flush()
  return out
}

/** 把服务端返回的邮箱名从 modified UTF-7 还原成可读文本（已是明文时原样返回）。 */
export function decodeMailboxName(name) {
  const text = String(name ?? '')
  if (!text.includes('&')) return text
  return text.replace(/&([A-Za-z0-9+,]*)-/g, (match, payload) => {
    if (payload === '') return '&'
    try {
      return String.fromCharCode(...base64DecodeToCodeUnits(payload))
    } catch {
      return match
    }
  })
}

const EMAIL_PATTERN = /^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/
const HOST_PATTERN = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
/** 控制字符（含 CR/LF/NUL）——命令注入的第一道闸。 */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

function argsFail(message) {
  throw new MailArgsError(message)
}

function policyFail(message, detail) {
  throw new MailPolicyError(message, detail)
}

function fileFail(message, detail) {
  throw new MailFileError(message, detail)
}

/** 含控制字符即拒（CR/LF/NUL 会破坏 IMAP/SMTP 命令行与头部）。 */
export function assertNoControl(value, label) {
  if (CONTROL_PATTERN.test(value)) argsFail(`${label} 不能包含换行或控制字符`)
  return value
}

/**
 * 把字符串转成「线上字节的 latin1 视图」：IMAP/SMTP 的命令行只能逐字节发，
 * 非 ASCII（中文文件夹名、中文搜索词）必须先把 UTF-8 字节铺成字符再写入，
 * 否则 `Buffer.from(text, 'latin1')` 会把每个字符截断成低字节（中文搜索词会变成 \u0000）。
 */
export function toWire(value) {
  const text = String(value ?? '')
  return /[^\u0000-\u00ff]/.test(text) ? Buffer.from(text, 'utf8').toString('latin1') : text
}

/** IMAP quoted-string：转义反斜杠与双引号（控制字符已在上游拦下），并转成线上一字节一字符视图。 */
export function quoteImapString(value) {
  assertNoControl(value, 'IMAP 参数')
  const wire = toWire(value)
  return `"${wire.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** 校验账号 id（配置与工具入参的句柄）。 */
export function assertAccountId(value, label = 'account') {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) {
    argsFail(`${label} 必须是小写字母/数字/连字符组成的短标识（如 "work"、"163"）`)
  }
  return value
}

/** 校验邮箱地址（宽松但拒引号与空白，避免头部注入）。 */
export function assertEmailAddress(value, label = '邮箱地址') {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    argsFail(`${label} 不是合法邮箱地址：${String(value)}`)
  }
  return value.trim()
}

/** 解析 "显示名 <地址>" 形态；失败时返回 null。 */
export function parseAddress(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const match = /^(?<name>.*?)<(?<address>[^<>]+)>$/.exec(value.trim())
  if (match?.groups !== undefined) {
    return { name: match.groups.name.trim().replace(/^"|"$/g, ''), address: match.groups.address.trim() }
  }
  return { name: '', address: value.trim() }
}

/** 校验主机名（域名或 IPv4 字面量）。 */
export function assertHost(value, label = '服务器地址') {
  const host = typeof value === 'string' ? value.trim() : ''
  if (host === '' || (!HOST_PATTERN.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host))) {
    argsFail(`${label} 不是合法主机名：${String(value)}`)
  }
  return host.toLowerCase()
}

/** 校验端口。 */
export function assertPort(value, label = '端口') {
  if (!Number.isInteger(value) || value < 1 || value > 65535) argsFail(`${label} 必须是 1-65535 的整数`)
  return value
}

/** 是否本机回环地址（回环允许明文连接，用于本地测试与自建网关）。 */
export function isLoopbackHost(host) {
  const normalized = host.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]'
}

/** 是否私网/内网地址（企业自建邮件服务器常用）。 */
export function isPrivateHost(host) {
  if (isLoopbackHost(host)) return true
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match !== null) return true
  // 无点单标签主机名（如 mail）走内网解析
  return !host.includes('.')
}

/**
 * 邮件主机策略闸：明文（secure=false 且非回环）拒绝；私网地址需显式放行。
 * @param {{host: string, port: number, secure: boolean}} endpoint
 * @param {{allowPrivateHosts?: boolean, allowInsecure?: boolean}} [policy]
 * @param {string} label 用于报错的中文标签（如「IMAP 服务器」）
 */
export function assertEndpointPolicy(endpoint, policy = {}, label = '邮件服务器') {
  if (endpoint.secure === false && !isLoopbackHost(endpoint.host) && policy.allowInsecure !== true) {
    policyFail(
      `${label} ${endpoint.host}:${endpoint.port} 是明文连接：案件邮件内容与授权码不允许明文传输`,
      { host: endpoint.host },
    )
  }
  if (isPrivateHost(endpoint.host) && policy.allowPrivateHosts !== true) {
    policyFail(
      `${label} ${endpoint.host} 属于本机/内网地址：默认不放行，如确为企业自建邮件服务器请在插件配置中开启 allowPrivateHosts`,
      { host: endpoint.host },
    )
  }
  return endpoint
}

/** 把服务商预设与显式覆盖合并成一个端点（显式值优先）。 */
export function resolveEndpoint(preset, override = {}, label = '邮件服务器') {
  const source = override ?? {}
  const host = assertHost(source.host ?? preset.host, `${label}地址`)
  const port = assertPort(source.port ?? preset.port, `${label}端口`)
  const secure = source.secure ?? preset.secure ?? (port === 993 || port === 465)
  if (typeof secure !== 'boolean') argsFail(`${label}的 secure 必须是布尔值`)
  return { host, port, secure }
}

/** 按服务商名取预设；未知服务商返回 null（要求显式给主机）。 */
export function providerPreset(provider) {
  if (provider === undefined || provider === null || provider === '') return null
  const key = String(provider).trim().toLowerCase()
  const preset = PROVIDER_PRESETS[key]
  if (preset === undefined) {
    argsFail(`未知的邮箱服务商 "${provider}"（可选：${Object.keys(PROVIDER_PRESETS).join('、')}；其他服务商请直接给 imap/smtp 主机）`)
  }
  return { key, ...preset }
}

/** 校验文件夹名（IMAP mailbox）：非空、无控制字符（中文文件夹名合法）。 */
export function assertFolderName(value, label = '文件夹') {
  if (typeof value !== 'string' || value.trim() === '') argsFail(`${label}必须是非空字符串（如 INBOX、Sent、"已发送"）`)
  return assertNoControl(value.trim(), label)
}

/** 校验 UID（IMAP UID 是 32 位无符号整数）。 */
export function assertUid(value, label = 'uid') {
  if (!Number.isInteger(value) || value < 1 || value > 4294967295) argsFail(`${label} 必须是正整数（IMAP UID）`)
  return value
}

/**
 * 解析搜索日期：接受 YYYY-MM-DD、YYYY/MM/DD、ISO 时间串与 Date 可解析串，重排为标准 IMAP 日期。
 * 拒绝无法解析的输入（绝不做「原样透传」——那会把任意串拼进 IMAP 命令）。
 */
export function parseImapDate(value, label = '日期') {
  if (typeof value !== 'string' || value.trim() === '') argsFail(`${label} 必须是非空字符串（如 2026-01-31）`)
  const raw = value.trim()
  assertNoControl(raw, label)
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw.replaceAll('/', '-')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) argsFail(`${label} 不是可识别的日期：${raw}（建议 2026-01-31）`)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${parsed.getUTCDate()}-${months[parsed.getUTCMonth()]}-${parsed.getUTCFullYear()}`
}

/** 解析发信时间（内部 Date 头）为 ISO 串；无法解析返回 null（不猜测）。 */
export function parseMailDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value.trim())
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

/**
 * 清洗附件文件名：去路径分隔符与盘符、去控制字符、去首尾点与空格、
 * 规避 Windows 保留名；空结果回退为 attachment。
 * @returns {string} 可直接 join 到目标目录的安全文件名
 */
export function sanitizeAttachmentName(name) {
  const raw = typeof name === 'string' ? name : ''
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 180)
  // 清洗后没有任何字母/数字/中日韩字符（如 '???' → '___'）视同无文件名，回退为 attachment
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || !/[\p{L}\p{N}]/u.test(cleaned)) return 'attachment'
  const stem = cleaned.includes('.') ? cleaned.slice(0, cleaned.lastIndexOf('.')) : cleaned
  if (WINDOWS_RESERVED.has(stem.toLowerCase())) return `${cleaned}.file`
  return cleaned
}

/** 危险类型闸：返回被拒的原因，合法返回 null。 */
export function blockedAttachmentReason(name) {
  const extension = extname(name).toLowerCase()
  if (extension !== '' && BLOCKED_ATTACHMENT_EXTENSIONS.includes(extension)) {
    return `附件 ${name} 是 ${extension} 类型（可执行/脚本），默认拒收以防在律师电脑上运行`
  }
  return null
}

/**
 * 解析并约束落盘目录：必须是绝对路径，且（给了根目录时）落在根目录内。
 * @param {string} requested 工具入参里的目录（相对路径按 saveRoot 解析）
 * @param {string} saveRoot 配置的附件保存根目录（绝对路径）
 */
export function resolveAttachmentDirectory(requested, saveRoot) {
  if (typeof saveRoot !== 'string' || saveRoot.trim() === '' || !isAbsolute(saveRoot)) {
    fileFail('插件配置 attachmentSaveRoot 必须是绝对路径：附件只允许保存到律师指定的目录内')
  }
  const root = resolve(saveRoot)
  const target = requested === undefined || requested === null || requested === ''
    ? root
    : resolve(isAbsolute(requested) ? requested : join(root, requested))
  const relative = target === root ? '' : target.startsWith(root + sep) ? target.slice(root.length + 1) : null
  if (relative === null) {
    fileFail(`附件保存目录必须位于允许的根目录内：${root}（收到 ${target}）`)
  }
  return { root, target, relative }
}

/** 唯一的落盘文件名：同名时追加 -1/-2…；用 exists 回调注入真实 fs 检查。 */
export function uniqueFileName(directory, fileName, exists) {
  if (!exists(join(directory, fileName))) return fileName
  const extension = extname(fileName)
  const stem = extension === '' ? fileName : fileName.slice(0, -extension.length)
  for (let index = 1; index < 1000; index++) {
    const candidate = `${stem}-${index}${extension}`
    if (!exists(join(directory, candidate))) return candidate
  }
  fileFail(`目标目录内同名附件过多，无法生成唯一文件名：${normalize(fileName)}`)
}

export { argsFail, policyFail, fileFail }
