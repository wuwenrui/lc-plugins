/**
 * 附件下载的纯逻辑（子进程侧，零依赖 ESM）：字节精确提取 + 文件名净化。
 *
 * 为什么不直接用 mime.js parseMail 的 attachments[].bytes：
 * parsePart 的附件字节走 decodeAttachmentBytes（按 base64 清洗），对
 * quoted-printable / 8bit 附件会解错；且 splitMultipart 按 /\r?\n/ 切行后
 * join('\n') 会把部件内部的 CRLF 压成 LF——base64/QP 不受影响（解码前会
 * 丢空白），但 8bit/binary 二进制附件会被破坏。下载必须字节精确，所以这里
 * 在原始报文（IMAP 取回的 latin1 字节视图串）上按 boundary 做保下标切分，
 * 每个附件部件拿到「原始字节区间」，再按 Content-Transfer-Encoding 解码：
 *   base64 / quoted-printable → 解码成字节；7bit/8bit/binary → latin1 直取。
 *
 * 文件名编码（用户重点）：decodeAttachmentFilename（mime-word.js）已处理
 * RFC 2047（=?GBK?B?…?= / =?UTF-8?Q?…?=）、RFC 2231（filename*=GBK''%..）、
 * 裸 UTF-8 / 裸 GBK 字节三种形态；本模块再对落盘名做净化（去路径分隔符与
 * 控制字符、限长保扩展名、无扩展名时按 MIME 类型补）与同目录去重（不覆盖）。
 *
 * 遍历顺序与 mime.js collectAttachmentParts 完全一致（multipart 子部件按序、
 * message/rfc822 递归为嵌套信件而非附件部件），因此「第 N 个附件」两套解析同名同序。
 */

import { parseHeaderBlock, parseParameters, decodePartBytes } from './mime.js'
import { decodeAttachmentFilename } from './mime-word.js'

const MAX_DEPTH = 16
/** 落盘文件名上限（APFS 单名 255 UTF-8 字节；留余量给去重后缀）。 */
const MAX_NAME_BYTES = 180
/** 空名/不可用名时的兜底。 */
const FALLBACK_NAME = 'attachment'

/** 常见 MIME 类型 → 扩展名（文件名没有扩展名时补，认不出就不补）。 */
const EXTENSION_BY_TYPE = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/zip', '.zip'],
  ['application/x-rar-compressed', '.rar'],
  ['application/x-7z-compressed', '.7z'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['text/html', '.html'],
  ['application/json', '.json'],
  ['message/rfc822', '.eml'],
])

/**
 * 净化解码后的附件名，得到可安全落盘的文件名：
 * - 归一 NFC；去路径分隔符（/ \ 与旧 Mac 冒号）、控制字符；
 * - 折叠空白、去首尾点与空格（防隐藏文件/意外截断）；
 * - 超 180 UTF-8 字节时截断主干、保留扩展名；
 * - 完全没有扩展名时按 Content-Type 补常见扩展名（认不出不补）。
 */
export function sanitizeFilename(name, contentType = '') {
  let cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[/\\:]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (cleaned === '') cleaned = FALLBACK_NAME
  const dot = cleaned.lastIndexOf('.')
  const hasExtension = dot > 0 && dot >= cleaned.length - 11
  let stem = hasExtension ? cleaned.slice(0, dot) : cleaned
  let extension = hasExtension ? cleaned.slice(dot) : ''
  if (extension === '' || extension === '.') extension = EXTENSION_BY_TYPE.get(String(contentType).toLowerCase()) ?? ''
  while (stem !== '' && Buffer.byteLength(`${stem}${extension}`, 'utf8') > MAX_NAME_BYTES) {
    stem = stem.slice(0, stem.length - 1)
  }
  stem = stem.replace(/[\s.]+$/g, '')
  const final = `${stem === '' ? FALLBACK_NAME : stem}${extension}`
  return Buffer.byteLength(final, 'utf8') > 255 ? FALLBACK_NAME + extension : final
}

/**
 * 在 dir 里为 filename 找一个不冲突的落盘名：首个冲突加「 (2)」，再冲突
 * 「 (3)」…（永远不覆盖已有文件；exists 由调用方注入，便于测试）。
 */
export function uniqueTarget(dir, filename, exists = defaultExists) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  let candidate = filename
  for (let index = 2; exists(`${dir}/${candidate}`); index += 1) {
    const suffix = ` (${index})`
    let base = stem
    while (Buffer.byteLength(`${base}${suffix}${extension}`, 'utf8') > 255 && base !== '') {
      base = base.slice(0, base.length - 1)
    }
    candidate = `${base}${suffix}${extension}`
  }
  return `${dir}/${candidate}`
}

function defaultExists() {
  return false
}

/** 逐行扫描 body，保留每行的精确下标（line.text 不含行尾 CRLF/LF）。 */
function* eachLine(text) {
  const pattern = /\r?\n/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    yield { text: text.slice(start, match.index), start, endWithEol: match.index + match[0].length }
    start = match.index + match[0].length
  }
  if (start < text.length) {
    yield { text: text.slice(start), start, endWithEol: text.length }
  }
}

/**
 * 与 mime.js splitMultipart 同语义的保下标切分：返回 [{start, end}]（原始
 * 报文里的字节区间）。分界行本身不属于部件；紧贴分界行前的 CRLF 按
 * RFC 2046 属于分界符，一并剥掉（8bit/binary 部件字节因此精确）。
 */
function splitMultipartExact(body, boundary) {
  const open = `--${boundary}`
  const close = `--${boundary}--`
  const segments = []
  let currentStart = null
  let sawClose = false
  for (const line of eachLine(body)) {
    const trimmed = line.text.trimEnd()
    if (trimmed === open || trimmed === close) {
      if (currentStart !== null) {
        let end = line.start
        if (body.slice(line.start - 2, line.start) === '\r\n') end = line.start - 2
        else if (body.slice(line.start - 1, line.start) === '\n') end = line.start - 1
        if (body.slice(currentStart, end).trim() !== '') segments.push({ start: currentStart, end })
        currentStart = null
      }
      if (trimmed === close) {
        sawClose = true
        break
      }
      currentStart = line.endWithEol
    }
  }
  if (currentStart !== null && !sawClose && body.slice(currentStart).trim() !== '') {
    segments.push({ start: currentStart, end: body.length })
  }
  return segments
}

/** 头部区/正文区的保下标切分（按第一个空行；与 splitHeaderBody 同判据）。 */
function splitHeaderBodyExact(text) {
  const match = /\r?\n\r?\n/.exec(text)
  if (match === null) return { headerStart: 0, headerEnd: text.length, bodyStart: text.length }
  return { headerStart: 0, headerEnd: match.index, bodyStart: match.index + match[0].length }
}

function firstHeader(headers, key) {
  const value = headers[key]
  return Array.isArray(value) ? value[0] : value
}

/**
 * 在原始报文上递归找全部附件部件，遍历顺序与 collectAttachmentParts 一致。
 * 每个 attachment 节点：{
 *   filename（已解码，落盘用）, rawFilename（原始头值，供精确匹配）,
 *   contentType, encoding, disposition, inline, body（该部件正文的原始字节视图串）
 * }
 */
export function collectExactAttachments(raw, rootHeaders = null) {
  const text = typeof raw === 'string' ? raw : raw.toString('latin1')
  const top = splitHeaderBodyExact(text)
  const headers = rootHeaders ?? parseHeaderBlock(text.slice(top.headerStart, top.headerEnd))
  const found = []
  walk(text.slice(top.bodyStart), headers, 0, found)
  return found
}

function walk(body, headers, depth, found) {
  const contentTypeHeader = firstHeader(headers, 'content-type')
  const { value: contentType, params } = parseParameters(contentTypeHeader ?? 'text/plain')
  const dispositionHeader = firstHeader(headers, 'content-disposition')
  const disposition = parseParameters(dispositionHeader ?? '')
  const rawName = params.name ?? ''
  const rawFilename = disposition.params.filename ?? rawName
  const contentId = String(firstHeader(headers, 'content-id') ?? '').replace(/^<|>$/g, '')
  const type = contentType === '' ? 'text/plain' : contentType

  if (type.startsWith('multipart/') && depth < MAX_DEPTH) {
    const boundary = params.boundary ?? ''
    if (boundary === '') return
    for (const segment of splitMultipartExact(body, boundary)) {
      const segmentText = body.slice(segment.start, segment.end)
      const split = splitHeaderBodyExact(segmentText)
      walk(
        segmentText.slice(split.bodyStart),
        parseHeaderBlock(segmentText.slice(split.headerStart, split.headerEnd)),
        depth + 1,
        found,
      )
    }
    return
  }
  // message/rfc822：与 mime.js parsePart 同语义——递归为嵌套信件（不是附件部件）。
  if (type === 'message/rfc822' && depth < MAX_DEPTH) {
    const split = splitHeaderBodyExact(body)
    walk(body.slice(split.bodyStart), parseHeaderBlock(body.slice(split.headerStart, split.headerEnd)), depth + 1, found)
    return
  }
  const isText = type.startsWith('text/')
  const hasFileName = rawFilename !== '' || disposition.value === 'attachment'
  if (!isText || hasFileName) {
    found.push({
      filename: decodeAttachmentFilename(rawFilename),
      rawFilename,
      contentType: type,
      encoding: String(firstHeader(headers, 'content-transfer-encoding') ?? '').trim().toLowerCase(),
      disposition: disposition.value,
      inline: disposition.value === 'inline' || contentId !== '',
      body,
    })
  }
}

/** 附件部件正文 → 精确字节（按传输编码解码；7bit/8bit/binary 即原始字节）。 */
export function attachmentBytes(part) {
  return decodePartBytes(part.body, part.encoding)
}
