/**
 * 邮件头部编解码纯逻辑（不依赖 cordis / dsh 包，不发网络请求）。
 *
 * 两块职责：
 * 1. 解码（读信）：RFC 2047 encoded-word（=?GBK?B?…?=，中文邮件最常见）→ UTF-8 字符串；
 *    支持 B/Q 两种编码、连续 encoded-word 之间的空白折叠，以及 charset 别名归并
 *    （GB2312/GBK → gbk，纯 ASCII 的 us-ascii 直通）。未知 charset 不猜测：保留原文并标记。
 * 2. 编码（发信）：RFC 2047 要求头部只能有 ASCII；含中文的名字与主题用
 *    `=?UTF-8?B?…?=` 编码，纯 ASCII 时保持可读原文（长行按 76 字符上限切分为多个 encoded-word）。
 *    正文不在这里编码——正文统一 UTF-8（只有正文与结构化地址允许 8BITMIME）。
 */

/** 需要特殊处理的语言字符集别名（其余交给 TextDecoder 判断）。 */
const CHARSET_ALIASES = new Map([
  ['gb2312', 'gbk'],
  ['gb_2312', 'gbk'],
  ['gb2312-80', 'gbk'],
  ['csgb2312', 'gbk'],
  ['chinese', 'gbk'],
  ['gb18030', 'gb18030'],
  ['x-gbk', 'gbk'],
  ['ansi_x3.4-1968', 'windows-1252'],
  ['us-ascii', 'utf-8'],
  ['ascii', 'utf-8'],
  ['utf8', 'utf-8'],
  ['unicode-1-1-utf-8', 'utf-8'],
  ['ks_c_5601-1987', 'euc-kr'],
  ['shift_jis', 'shift_jis'],
  ['sjis', 'shift_jis'],
])

/** 归并 charset 别名。 */
export function normalizeCharset(charset) {
  const value = typeof charset === 'string' ? charset.trim().toLowerCase().replace(/^["']|["']$/g, '') : ''
  if (value === '') return 'utf-8'
  return CHARSET_ALIASES.get(value) ?? value
}

/**
 * 用指定 charset 解码字节；未知 charset 抛错（由调用方兜底），不用替换字符静默糊掉。
 * @param {Buffer} bytes
 * @param {string} charset
 */
export function decodeBytes(bytes, charset) {
  return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes)
}

/** 按 charset 解码，失败时回退 utf-8，再失败回退 latin1（保证永不解码抛错）。 */
export function decodeBytesLenient(bytes, charset) {
  try {
    return decodeBytes(bytes, charset)
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
}

/** 解码结果里混入控制字符或替换字符，说明这次「猜解码」没猜对。 */
const CONTROL_OR_REPLACEMENT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/

/** 中日韩表意文字（判定「这段字节像不像中文名」的唯一依据）。 */
const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 参数值里的 percent 转义 %XX 还原成**字节**（不是码点）。
 *
 * 为什么必须在这一层还原：RFC 2231 的 `%E5%8C%97` 是**字节**的三段十六进制，
 * 先 decodeURIComponent 会先得到 Unicode 码点（北 U+5317），再 Buffer.from(…, 'latin1')
 * 就只剩低 8 位（0x17），字节流被永久破坏（2026-09-13 百望云发票附件名的乱码根因）。
 * 非 ASCII 的字面字符（畸形邮件的裸字节视图）按「≤0xFF 即一个字节」处理，其余按 UTF-8 兜底。
 * @param {string} value
 * @returns {Buffer}
 */
export function percentEscapesToBytes(value) {
  const text = typeof value === 'string' ? value : ''
  const bytes = []
  let index = 0
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index))
    if (char === '%') {
      const hex = text.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 3
        continue
      }
      bytes.push(0x25)
      index += 1
      continue
    }
    const code = char.codePointAt(0)
    if (code <= 0xff) bytes.push(code)
    else bytes.push(...Buffer.from(char, 'utf8'))
    index += char.length
  }
  return Buffer.from(bytes)
}

/**
 * 把一段「线上字节的 latin1 视图」还原成文本：先按严格 UTF-8 试（不解出替换字符才算成功），
 * 不是 UTF-8 时按 GBK/GB18030 试（中文服务商的裸 GBK 附件名），都不成立就保留原文。
 * 严格模式（fatal:true）是关键——宽松模式会把无法解码的字节变成 U+FFFD 写进文件名，
 * 那正是线上落盘名 `...-�~�z�рPl�.pdf` 的来源。
 * @param {string} wire latin1 字节视图
 */
function recoverWireBytesText(wire) {
  if (wire === '') return ''
  const bytes = Buffer.from(wire, 'latin1')
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!CONTROL_OR_REPLACEMENT.test(utf8)) return utf8
  } catch {
    // 不是 UTF-8，继续试 GBK
  }
  try {
    const gbk = new TextDecoder('gbk', { fatal: true }).decode(bytes)
    if (CJK_IDEOGRAPH.test(gbk)) return gbk
  } catch {
    // 也不是 GBK，保留原文
  }
  return wire
}

/**
 * 解 RFC 2231 扩展参数值 `charset'language'percent-encoded`（无 charset 段时整段都是转义体）。
 * @param {string} value 形如 `UTF-8''%E5%8C%97%E4%BA%AC`
 */
export function decodeRfc2231Value(value) {
  const text = typeof value === 'string' ? value : ''
  const segments = text.split("'")
  const hasCharset = segments.length >= 3
  const charset = hasCharset ? segments[0].trim() : ''
  const encoded = hasCharset ? segments.slice(2).join("'") : text
  const bytes = percentEscapesToBytes(encoded)
  if (charset !== '') {
    try {
      return decodeBytes(bytes, charset)
    } catch {
      // 未知 charset 不猜测：按线上字节兜底（UTF-8 → GBK）
    }
  }
  return recoverWireBytesText(bytes.toString('latin1'))
}

/**
 * 附件文件名解码：一个函数吃掉三种线上形态，且**不对已正确的 UTF-8 二次解码**。
 * 1. RFC 2047 encoded-word（`=?GBK?B?…?=`，少数服务端在 BODYSTRUCTURE 里也直接回这个）；
 * 2. 裸字节视图：UTF-8 字节（→ 还原）与 GBK/GB2312 字节（→ 按 GBK 解）；
 * 3. 已是正常 Unicode 文本（含 >U+00FF 的字符）→ 原样返回。
 * @param {string} value
 */
export function decodeAttachmentFilename(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return ''
  if (text.includes('=?')) return decodeHeaderValue(text).text
  if (/[^\u0000-\u00ff]/.test(text)) return recoverUtf8Header(text)
  return recoverWireBytesText(text)
}

/** 解 Q 编码（quoted-printable 的 encoded-word 变体：下划线=空格）。 */
function decodeQEncodedWord(payload, charset) {
  const normalized = payload.replaceAll('_', ' ')
  const bytes = []
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    if (char === '=' && index + 2 < normalized.length) {
      const hex = normalized.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    bytes.push(...Buffer.from(char, 'utf8'))
  }
  return decodeBytesLenient(Buffer.from(bytes), charset)
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g

/** 是不是「高字节按 latin1 呈现」的形态（真实 UTF-8 字节被 toString('latin1') 摊开后的典型特征）。 */
function looksLikeMojibake(value) {
  return /[\u00c2-\u00c3][\u0080-\u00bf]|[\u00e0-\u00ef][\u0080-\u00bf]{1,2}/.test(value)
}

/**
 * 还原未经 RFC 2047 编码的裸 UTF-8 头部（现实中文邮件常见）：把按 latin1 摊开的字符串
 * 收成真字节再按 UTF-8 解一次；解不出（或结果更差）就保留原文。
 * 已解码出来的正常文本（如「扫描件」）不匹配 mojibake 特征，因此不会被二次解码破坏。
 */
/** 线上字节视图 → UTF-8 文本的工具名（协议层与头部解码共用同一判定）。 */
export function recoverWireText(value) {
  return recoverUtf8Header(value)
}

/** 还原未经 RFC 2047 编码的裸 UTF-8 文本（现实中文邮件与中文文件夹名常见）。 */
export function recoverUtf8Header(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '' || !looksLikeMojibake(text)) return text
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'latin1'))
    // 还原后如果混入了替换字符或控制字符，说明本来就不是 UTF-8，保留原文
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(decoded) ? text : decoded
  } catch {
    return text
  }
}

/**
 * 头部里「encoded-word 之外」那段原始字节的还原。
 *
 * 现实中的中文头部经常混排：`=?GBK?B?…?=-2026<裸 UTF-8 字节>.pdf` —— encoded-word 声明 GBK，
 * 段外却是裸 UTF-8。整串一起做严格 UTF-8 解码必然失败（前面已有正确中文，混着 latin1 视图的
 * 字节段解不出），尾巴就一直是 `å¹´2æ`. 所以**逐段**还原：
 * 先按严格 UTF-8 试，再按同一头部声明的 charset 试，最后按 GBK 试；都不是就原样保留（不猜）。
 * 纯 ASCII 段与已是正常 Unicode 文本（含 >U+00FF 字符）的段一律不动。
 */
function recoverHeaderText(value, hintCharset = '') {
  const text = typeof value === 'string' ? value : ''
  if (text === '' || !/[\u0080-\u00ff]/.test(text)) return text
  if (/[^\u0000-\u00ff]/.test(text)) return recoverUtf8Header(text)
  const bytes = Buffer.from(text, 'latin1')
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!CONTROL_OR_REPLACEMENT.test(utf8)) return utf8
  } catch {
    // 不是裸 UTF-8，继续按声明的 charset 试
  }
  if (hintCharset !== '') {
    try {
      const hinted = decodeBytes(bytes, hintCharset)
      if (!hinted.includes('\ufffd')) return hinted
    } catch {
      // 未知 charset：落到 GBK 兜底
    }
  }
  try {
    const gbk = new TextDecoder('gbk', { fatal: true }).decode(bytes)
    if (CJK_IDEOGRAPH.test(gbk)) return gbk
  } catch {
    // 也不是 GBK，保留原文
  }
  return text
}

/**
 * 解码一个头部值里的全部 RFC 2047 encoded-word。
 * @param {string} value 原始头部值（可能含多段 encoded-word 与普通文本）
 * @returns {{ text: string, encoded: boolean, unknownCharsets: string[] }} unknownCharsets 非空表示有段落未能按声明字符集解码
 */
export function decodeHeaderValue(value) {
  if (typeof value !== 'string' || !value.includes('=?')) {
    return { text: recoverUtf8Header(typeof value === 'string' ? value : ''), encoded: false, unknownCharsets: [] }
  }
  const unknown = new Set()
  let matched = false
  /** 同一头部里 encoded-word 声明的 charset：段外原始字节的还原提示（先出现的优先）。 */
  let hintCharset = ''
  const parts = []
  let lastIndex = 0
  ENCODED_WORD.lastIndex = 0
  let match
  while ((match = ENCODED_WORD.exec(value)) !== null) {
    matched = true
    const [raw, charset, encoding, payload] = match
    // encoded-word 之间的空白按 RFC 2047 折叠（同一词被拆成多段时不能插空格）
    const gap = value.slice(lastIndex, match.index)
    if (gap !== '') {
      // 纯空白的段间分隔在「两侧都是 encoded-word」时按 RFC 2047 折叠掉，
      // 否则原样保留（普通文本与 encoded-word 混排时的空格是内容的一部分）。
      const betweenEncodedWords = parts.length > 0 && gap.trim() === ''
      // 段外原始字节逐段还原（段首还没有 hint 时用后面这个 encoded-word 的 charset）
      if (!betweenEncodedWords) parts.push(recoverHeaderText(gap, hintCharset === '' ? charset : hintCharset))
    }
    try {
      parts.push(encoding.toUpperCase() === 'B'
        ? decodeBytesLenient(Buffer.from(payload.replace(/\s+/g, ''), 'base64'), charset)
        : decodeQEncodedWord(payload, charset))
    } catch {
      unknown.add(charset)
      parts.push(raw)
    }
    if (hintCharset === '') hintCharset = charset
    lastIndex = match.index + raw.length
  }
  if (!matched) return { text: value, encoded: false, unknownCharsets: [] }
  // 最后一个 encoded-word 之后的尾巴同样逐段还原（线上 `…?=-2026<裸 UTF-8>.pdf` 就是这一段）
  parts.push(recoverHeaderText(value.slice(lastIndex), hintCharset))
  return { text: recoverUtf8Header(parts.join('')), encoded: true, unknownCharsets: [...unknown] }
}

/** 解码后即得到纯文本（大多数调用点用这个）。 */
export function decodeHeader(value) {
  return decodeHeaderValue(value).text
}

/** 判断字符串是否已是纯 ASCII（可安全进出 SMTP 命令行与头部）。 */
export function isAscii(value) {
  return !/[^\u0000-\u007f]/.test(value)
}

/**
 * 需要时把头部值编码为 RFC 2047（UTF-8 / Base64）：纯 ASCII 原样返回。
 * 按 UTF-8 字节边界切成 ≤45 字节的段（编码后 ≤60 字符，留足行宽余量）。
 * @param {string} value
 */
export function encodeHeaderValue(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (isAscii(text)) return text
  const bytes = Buffer.from(text, 'utf8')
  const chunks = []
  const MAX_BYTES = 45
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + MAX_BYTES, bytes.length)
    // 不要切断多字节序列：回退到 UTF-8 起始字节
    while (end > start + 1 && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(start, end).toString('base64'))
    start = end
  }
  return chunks.map(chunk => `=?UTF-8?B?${chunk}?=`).join(' ')
}

/**
 * 编码一个地址头（"张三" <a@b.com> 或裸地址）。
 * 名字部分需要时做 RFC 2047；地址必须已是 ASCII（含非 ASCII 的地址非法，直接拒）。
 */
export function encodeAddressHeader(address, name = '') {
  const addr = String(address ?? '').trim()
  if (addr === '' || !isAscii(addr)) {
    throw new Error(`收件人地址必须是 ASCII 邮箱地址：${String(address)}`)
  }
  const display = String(name ?? '').trim()
  if (display === '') return addr
  return isAscii(display)
    ? `${/[,;:<>@"]/.test(display) ? `"${display.replaceAll('"', '')}"` : display} <${addr}>`
    : `${encodeHeaderValue(display)} <${addr}>`
}

/** 把地址列表拼成头部值（逐项编码，逗号分隔）。 */
export function encodeAddressList(items) {
  return items.map(item => encodeAddressHeader(item.address, item.name)).join(', ')
}

/**
 * 解析地址头为 [{name, address}]：支持 "Name <a@b>"、编码名、以及纯地址列表。
 * 只在逗号处切分（引号内的逗号不切）。
 */
export function parseAddressList(value) {
  const text = decodeHeader(value ?? '')
  const items = []
  let current = ''
  let inQuotes = false
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes
    if (char === ',' && !inQuotes) {
      items.push(current)
      current = ''
      continue
    }
    current += char
  }
  items.push(current)
  return items
    .map(item => item.trim())
    .filter(item => item !== '')
    .map((item) => {
      const match = /^(?<name>.*?)<\s*(?<address>[^>]+)\s*>$/.exec(item)
      if (match?.groups !== undefined) {
        const name = match.groups.name.trim().replace(/^"|"$/g, '').trim()
        return { name, address: match.groups.address.trim() }
      }
      return { name: '', address: item.replace(/^"|"$/g, '').trim() }
    })
    .filter(item => item.address !== '')
}
