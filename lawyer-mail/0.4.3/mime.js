/**
 * MIME 报文解析与生成纯逻辑（不依赖 cordis / dsh 包，不发网络请求）。
 *
 * 读信（解析）：把 IMAP 取回的 RFC 822 字节流拆成头部 + MIME 树，
 *   - 头部折行（RFC 5322 folding）还原、头部名小写归一；
 *   - Content-Type / Content-Disposition / Content-Transfer-Encoding 参数解析（含 RFC 2231 与引号）；
 *   - 正文按 charset 解码（GBK/GB18030/Big5 等中文邮件常见编码经 mime-word 归一），
 *     传输编码支持 7bit/8bit/binary/base64/quoted-printable；
 *   - message/rfc822（转发邮件）递归成子结构，不吞内容。
 *
 * 发信（生成）：构造 UTF-8 正文 + 可选附件的标准 MIME 报文，头部按需做 RFC 2047 编码，
 *   附件一律 base64，正文用 base64 传输编码（避开 8BITMIME 与点填充的兼容性问题）。
 *
 * 设计口径：解析器「永不因畸形邮件抛错」——律师收到的真实邮件经常不规范，
 * 遇到异常结构降级为可读的文本块并保留原始片段，而不是让工具整体失败。
 */

import { decodeAttachmentFilename, decodeBytesLenient, decodeHeader, decodeRfc2231Value, encodeAddressHeader, encodeHeaderValue, parseAddressList } from './mime-word.js'

/** 解析单个 Content-* 参数串（; 分隔，支持 k=v、k="v"、RFC 2231 的 k*=charset''v）。 */
export function parseParameters(value) {
  const params = {}
  const text = typeof value === 'string' ? value : ''
  const parts = []
  let current = ''
  let inQuotes = false
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes
    if (char === ';' && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  const [first, ...rest] = parts
  for (const part of rest) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const rawKey = part.slice(0, index).trim().toLowerCase()
    let rawValue = part.slice(index + 1).trim()
    if (/^".*"$/.test(rawValue)) rawValue = rawValue.slice(1, -1).replace(/\\(.)/g, '$1')
    if (rawKey.endsWith('*')) {
      // RFC 2231：charset'language'percent-encoded。
      // 必须把 %XX 直接还原成**字节**再按 charset 解一次；先 decodeURIComponent 会先得到码点，
      // 随后的 latin1 截断会把行首无字节的高位丢掉（中文名变乱码 + U+FFFD，2026-09-13 线上实测）。
      const key = rawKey.slice(0, -1)
      params[key] = decodeRfc2231Value(rawValue)
      continue
    }
    params[rawKey] = rawValue
  }
  return { value: (first ?? '').trim().toLowerCase(), params }
}

/** 拆分头部区与正文区（按第一个空行）。 */
export function splitHeaderBody(raw) {
  const text = typeof raw === 'string' ? raw : raw.toString('latin1')
  const match = /\r?\n\r?\n/.exec(text)
  if (match === null) return { headerText: text, bodyText: '' }
  return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) }
}

/** 解析头部区（含折行还原），键小写；同名头合并为数组。 */
export function parseHeaderBlock(headerText) {
  const headers = {}
  const unfolded = String(headerText ?? '').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    if (headers[key] === undefined) headers[key] = value
    else if (Array.isArray(headers[key])) headers[key].push(value)
    else headers[key] = [headers[key], value]
  }
  return headers
}

/** 解码传输编码：7bit/8bit/binary 视为原始字节。畸形 base64 不抛错，尽力解出可读内容。 */
export function decodeTransfer(bodyText, encoding, charset = 'utf-8') {
  const normalized = String(encoding ?? '').trim().toLowerCase()
  const raw = typeof bodyText === 'string' ? bodyText : bodyText.toString('latin1')
  if (normalized === 'base64') {
    // latin1 是 IMAP 字面量的字节视图：必须按 latin1 还原成字节再解 base64，
    // 否则 UTF-8 字节会被 utf8 编码二次放大（曾导致引用正文里的中文变成替换字符）。
    const cleaned = raw.replace(/[^A-Za-z0-9+/=]/g, '')
    return decodeBytesLenient(Buffer.from(cleaned, 'base64'), charset === '' ? 'utf-8' : charset)
  }
  if (normalized === 'base64-bytes') {
    return ''
  }
  if (normalized === 'quoted-printable') {
    const bytes = decodeQuotedPrintableBytes(raw)
    return decodeBytesLenient(bytes, charset === '' ? 'utf-8' : charset)
  }
  return decodeBytesLenient(Buffer.from(raw, 'latin1'), charset === '' ? 'utf-8' : charset)
}

/** quoted-printable → 原始字节（软换行丢弃，=XX 还原）。 */
export function decodeQuotedPrintableBytes(bodyText) {
  const text = String(bodyText ?? '')
  const withoutSoftBreaks = text.replace(/=(?:\r?\n)/g, '')
  const bytes = []
  for (let index = 0; index < withoutSoftBreaks.length; index++) {
    const char = withoutSoftBreaks[index]
    if (char === '=') {
      const hex = withoutSoftBreaks.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    bytes.push(...Buffer.from(char, 'utf8'))
  }
  return Buffer.from(bytes)
}

/** 附件字节的 base64 载荷（保留原始字节，不做文本解码）。 */
export function decodeAttachmentBytes(bodyText) {
  const cleaned = String(bodyText ?? '').replace(/[^A-Za-z0-9+/=]/g, '')
  return Buffer.from(cleaned, 'base64')
}

/**
 * 按传输编码把「部件文本」解成原始字节（下载附件用）。
 * base64/quoted-printable 要解成字节，7bit/8bit/binary 直接按 latin1 取字节——
 * 先当文本再当 base64 会双重解码，把二进制附件解成垃圾（曾在真实验收里暴露）。
 */
export function decodePartBytes(partText, encoding = '') {
  const raw = String(partText ?? '')
  const normalized = String(encoding ?? '').trim().toLowerCase()
  if (normalized === 'base64') return decodeAttachmentBytes(raw)
  if (normalized === 'quoted-printable') return decodeQuotedPrintableBytes(raw)
  return Buffer.from(raw, 'latin1')
}

/** 块边界切分：仅按 boundary 切，不按 "--" 之后的空白差异切（真实邮件差异很大）。 */
export function splitMultipart(bodyText, boundary) {
  const lines = String(bodyText ?? '').split(/\r?\n/)
  const segments = []
  let current = null
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed === `--${boundary}` || trimmed === `--${boundary}--`) {
      if (current !== null) segments.push(current.join('\n'))
      if (trimmed === `--${boundary}--`) {
        current = null
        break
      }
      current = []
      continue
    }
    if (current !== null) current.push(line)
  }
  if (current !== null && current.length > 0) segments.push(current.join('\n'))
  return segments.filter(segment => segment.trim() !== '')
}

const DEFAULT_MAX_DEPTH = 16

/**
 * 递归解析一个 MIME 部分。
 * @param {string} bodyText 该部分的正文（头部已剥离）
 * @param {object} headers 该部分的头部
 * @param {{depth?: number, maxDepth?: number}} [options]
 * @returns {object} 节点：{ kind, headers, headersDecoded, contentType, charset, encoding, name, filename, contentId, inline, text?, children?, bytes?, message? }
 */
export function parsePart(bodyText, headers, options = {}) {
  const depth = options.depth ?? 0
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const contentTypeHeader = Array.isArray(headers['content-type']) ? headers['content-type'][0] : headers['content-type']
  const { value: contentType, params } = parseParameters(contentTypeHeader ?? 'text/plain')
  const dispositionHeader = Array.isArray(headers['content-disposition']) ? headers['content-disposition'][0] : headers['content-disposition']
  const disposition = parseParameters(dispositionHeader ?? '')
  const encodingHeader = Array.isArray(headers['content-transfer-encoding']) ? headers['content-transfer-encoding'][0] : headers['content-transfer-encoding']
  const charset = params.charset ?? ''
  const name = params.name ?? ''
  const filename = disposition.params.filename ?? name
  const contentId = (Array.isArray(headers['content-id']) ? headers['content-id'][0] : headers['content-id'] ?? '').replace(/^<|>$/g, '')
  const decodedHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    decodedHeaders[key] = Array.isArray(value) ? value.map(item => decodeHeader(item)) : decodeHeader(value)
  }
  const base = {
    kind: 'part',
    /** 该部件的原始正文文本（未解码）；下载附件时按 encoding 解出字节用。 */
    rawText: typeof bodyText === 'string' ? bodyText : String(bodyText ?? ''),
    headers,
    headersDecoded: decodedHeaders,
    contentType: contentType === '' ? 'text/plain' : contentType,
    charset,
    encoding: (encodingHeader ?? '').toLowerCase(),
    disposition: disposition.value,
    name: decodeAttachmentFilename(name),
    filename: decodeAttachmentFilename(filename),
    contentId,
    inline: disposition.value === 'inline' || contentId !== '',
    depth,
  }

  if (base.contentType.startsWith('multipart/') && depth < maxDepth) {
    const boundary = params.boundary ?? ''
    if (boundary === '') return { ...base, kind: 'text', text: '[无法解析的多部分邮件：缺少 boundary]' }
    const children = splitMultipart(bodyText, boundary).map((segment) => {
      const { headerText, bodyText: childBody } = splitHeaderBody(segment)
      return parsePart(childBody, parseHeaderBlock(headerText), { depth: depth + 1, maxDepth })
    })
    return { ...base, kind: 'multipart', children }
  }

  if (base.contentType === 'message/rfc822' && depth < maxDepth) {
    const { headerText, bodyText: nestedBody } = splitHeaderBody(bodyText)
    return { ...base, kind: 'message', message: parsePart(nestedBody, parseHeaderBlock(headerText), { depth: depth + 1, maxDepth }) }
  }

  const isText = base.contentType.startsWith('text/')
  const hasFileName = filename !== '' || disposition.value === 'attachment'
  if (!isText || hasFileName) {
    const bytes = decodeAttachmentBytes(bodyText)
    // isAttachmentPart：MIME 头里明确写了 attachment 的才算「附件部件」；
    // 只有文件名（name=）而无 disposition 的按内嵌处理，避免把正文里的东西算成附件。
    return { ...base, kind: 'attachment', bytes, size: bytes.length, isAttachmentPart: disposition.value === 'attachment' }
  }
  return { ...base, kind: 'text', text: decodeTransfer(bodyText, base.encoding, charset) }
}

/**
 * 解析完整邮件（头部 + MIME 树）。
 * @param {string|Buffer} raw 原始报文（IMAP BODY[] 取回的内容）
 * @returns {{headers: object, headersDecoded: object, subject: string, from: object|null, to: object[], cc: object[], date: string|null, messageId: string, inReplyTo: string, references: string[], root: object, text: string, html: string, attachments: object[], truncated: boolean}}
 */
export function parseMail(raw, options = {}) {
  const text = typeof raw === 'string' ? raw : raw.toString('latin1')
  const { headerText, bodyText } = splitHeaderBody(text)
  const headers = parseHeaderBlock(headerText)
  const root = parsePart(bodyText, headers, options)
  const decoded = root.headersDecoded
  const texts = collectTextParts(root)
  const attachmentParts = collectAttachmentParts(root)
  const maxText = options.maxTextChars ?? Infinity
  const joinedText = texts.join('\n\n')
  return {
    headers,
    headersDecoded: decoded,
    subject: decoded.subject ?? '',
    from: parseAddressList(decoded.from ?? '')[0] ?? null,
    to: parseAddressList(decoded.to ?? ''),
    cc: parseAddressList(decoded.cc ?? ''),
    replyTo: parseAddressList(decoded['reply-to'] ?? '').map(item => item.address),
    date: decoded.date ?? null,
    messageId: (decoded['message-id'] ?? '').trim(),
    inReplyTo: (decoded['in-reply-to'] ?? '').trim(),
    references: (decoded.references ?? '').split(/\s+/).filter(item => item !== ''),
    root,
    text: joinedText,
    html: collectHtmlParts(root).join('\n\n'),
    attachments: attachmentParts.map(part => ({
      filename: part.filename,
      contentType: part.contentType,
      size: part.size ?? 0,
      contentId: part.contentId,
      inline: part.inline,
      bytes: part.bytes,
    })),
    truncated: Number.isFinite(maxText) && joinedText.length > maxText,
    bodyText: Number.isFinite(maxText) && joinedText.length > maxText ? joinedText.slice(0, maxText) : joinedText,
  }
}

/** 深度遍历 MIME 树。 */
export function walkParts(node, visit) {
  visit(node)
  if (node.kind === 'multipart') for (const child of node.children ?? []) walkParts(child, visit)
  if (node.kind === 'message' && node.message !== undefined) walkParts(node.message, visit)
}

/** 收集可读纯文本部分（跳过附件；text/html 也收，便于无纯文本正文时兜底）。 */
export function collectTextParts(root) {
  const parts = []
  walkParts(root, (node) => {
    if (node.kind === 'text' && node.contentType === 'text/plain') parts.push(node.text ?? '')
  })
  if (parts.length > 0) return parts.filter(text => text.trim() !== '')
  const html = []
  walkParts(root, (node) => {
    if (node.kind === 'text' && node.contentType === 'text/html') html.push(htmlToText(node.text ?? ''))
  })
  return html.filter(text => text.trim() !== '')
}

/** 收集 html 正文部分。 */
export function collectHtmlParts(root) {
  const parts = []
  walkParts(root, (node) => {
    if (node.kind === 'text' && node.contentType === 'text/html') parts.push(node.text ?? '')
  })
  return parts
}

/** 收集附件部分（带文件名或 disposition=attachment 的都算，内联图片也列出但标注 inline）。 */
export function collectAttachmentParts(root) {
  const parts = []
  walkParts(root, (node) => {
    if (node.kind === 'attachment') parts.push(node)
  })
  return parts
}

const HTML_ENTITIES = new Map([
  ['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'],
  ['&#39;', "'"], ['&apos;', "'"], ['&mdash;', '—'], ['&ndash;', '–'], ['&hellip;', '…'],
])

/** HTML → 纯文本（保留段落与表格行的换行；模型只需要能读懂的正文）。 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return ''
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  for (const [entity, char] of HTML_ENTITIES) text = text.replaceAll(entity, char)
  text = text.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 生成一个可用于 Message-ID / boundary 的随机标记。 */
export function randomToken(size = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let index = 0; index < size; index++) token += chars[Math.floor(Math.random() * chars.length)]
  return token
}

/** 生成 Message-ID（带发件域，便于对方按标准线程合并）。 */
export function makeMessageId(fromAddress, now = new Date()) {
  const domain = fromAddress.includes('@') ? fromAddress.slice(fromAddress.indexOf('@') + 1) : 'lawyer-desk'
  return `<${now.getTime().toString(36)}.${randomToken(10)}@${domain}>`
}

/**
 * 构造待发送/待保存的 MIME 报文。
 * 头部注入闸：任何头部值含 CR/LF 直接抛错（模型给的主题/收件人不得带换行拼头）。
 * @param {{from: {address: string, name?: string}, to: Array<{address: string, name?: string}>, cc?: Array<{address: string, name?: string}>, subject: string, text: string, inReplyTo?: string, references?: string[], attachments?: Array<{filename: string, contentType?: string, bytes: Buffer}>, date?: Date, messageId?: string}} input
 * @returns {{raw: Buffer, messageId: string, subject: string, to: string[], cc: string[], attachmentNames: string[]}}
 */
export function buildMail(input) {
  const date = input.date ?? new Date()
  const fromAddress = String(input.from?.address ?? '').trim()
  if (fromAddress === '') throw new Error('发件人地址不能为空')
  const messageId = input.messageId ?? makeMessageId(fromAddress, date)
  const subject = String(input.subject ?? '')
  const to = Array.isArray(input.to) ? input.to : []
  const cc = Array.isArray(input.cc) ? input.cc : []
  const attachments = Array.isArray(input.attachments) ? input.attachments : []
  const guard = (value, label) => {
    if (/[\r\n]/.test(String(value))) throw new Error(`${label} 不能包含换行`)
    return String(value)
  }
  const headers = [
    `From: ${guard(encodeAddressHeader(fromAddress, input.from?.name ?? ''), '发件人')}`,
    `To: ${guard(to.map(item => encodeAddressHeader(item.address, item.name)).join(', '), '收件人')}`,
    ...cc.length > 0 ? [`Cc: ${guard(cc.map(item => encodeAddressHeader(item.address, item.name)).join(', '), '抄送')}`] : [],
    `Subject: ${guard(encodeHeaderValue(subject), '主题')}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${guard(messageId, 'Message-ID')}`,
    'MIME-Version: 1.0',
    ...input.inReplyTo !== undefined && input.inReplyTo !== '' ? [`In-Reply-To: ${guard(input.inReplyTo, 'In-Reply-To')}`] : [],
    ...Array.isArray(input.references) && input.references.length > 0 ? [`References: ${guard(input.references.join(' '), 'References')}`] : [],
  ]

  const text = String(input.text ?? '')
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')
    const body = wrapBase64(Buffer.from(text, 'utf8'))
    return {
      raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8'),
      messageId,
      subject,
      to: to.map(item => item.address),
      cc: cc.map(item => item.address),
      attachmentNames: [],
    }
  }

  const boundary = `--=_lawyer-mail-${randomToken(16)}`
  // 头部与正文之间必须有空行（少了它整封邮件会被当成「只有头部」，
  // 附件部分变成正文、纯文本部分丢失——曾导致带附件的回信正文解析为空）。
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '')
  const chunks = [
    `${headers.join('\r\n')}\r\n`,
    `--${boundary}\r\n`,
    'Content-Type: text/plain; charset=UTF-8\r\n',
    'Content-Transfer-Encoding: base64\r\n\r\n',
    `${wrapBase64(Buffer.from(text, 'utf8'))}\r\n`,
  ]
  for (const attachment of attachments) {
    const name = guard(encodeHeaderValue(String(attachment.filename ?? 'attachment')), '附件名')
    const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(String(attachment.contentType ?? ''))
      ? String(attachment.contentType)
      : 'application/octet-stream'
    chunks.push(
      `--${boundary}\r\n`,
      `Content-Type: ${contentType}; name="${name}"\r\n`,
      `Content-Disposition: attachment; filename="${name}"\r\n`,
      'Content-Transfer-Encoding: base64\r\n\r\n',
      `${wrapBase64(attachment.bytes ?? Buffer.alloc(0))}\r\n`,
    )
  }
  chunks.push(`--${boundary}--\r\n`)
  return {
    raw: Buffer.from(chunks.join(''), 'utf8'),
    messageId,
    subject,
    to: to.map(item => item.address),
    cc: cc.map(item => item.address),
    attachmentNames: attachments.map(item => String(item.filename ?? 'attachment')),
  }
}

/** base64 按 76 字符换行（RFC 2045 行宽限制）。 */
export function wrapBase64(bytes) {
  const encoded = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(String(bytes), 'utf8').toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76))
  return lines.join('\r\n')
}
