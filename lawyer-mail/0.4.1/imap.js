/**
 * 最小 IMAP 客户端（纯协议实现，只依赖 node:net / node:tls，不依赖 cordis / dsh 包）。
 *
 * 为什么自己写而不引第三方库：插件制品要装进律师工作台，越小越可审；我们只需要一条主线——
 * 登录 → 列文件夹 → 搜索 → 取信头/正文/附件 → 存草稿，不需要 IDLE / CONDSTORE / 连接池。
 *
 * 解析模型（这个文件的历史坑都在这三行里）：
 * 1. 一次「响应」= 帧文本 + 若干字面量；帧里出现行尾 `{n}` 时，紧随的 n 字节是字面量。
 * 2. 字面量长度必须按**字节精确记账**，绝不从渲染后的文本反推：服务端写完字面量常常
 *    直接跟 `)`，文本里 `{n}` 后面并不是换行，任何「找 {n} 再取 n 字节」的启发式都会取错
 *    （曾导致正文与附件静默读空）。
 * 3. 响应的最终分发只发生在行循环里：非命令行的输入会走「未知行」分支并被丢弃，
 *    因此字面量结束后不能在缓冲处理里就地分发（否则整条 FETCH 响应被吃掉）。
 *
 * 安全：所有进入命令行的字符串经 quoteImapString（CR/LF/NUL 已拦），字面量长度按字节计算。
 * 读信一律用 BODY.PEEK[...]（不置 \Seen，不改动对方邮件的已读状态）。
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { MailNetworkError, MailProtocolError } from './errors.js'
import { decodeMailboxName, encodeMailboxName, quoteImapString, toWire } from './validate.js'
import { decodeAttachmentFilename, decodeRfc2231Value, recoverWireText } from './mime-word.js'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT_MS = 30000
const MAX_LITERAL_BYTES = 96 * 1024 * 1024

/** 极简事件发射器（测试里更好控，且不跨进程暴露）。 */
class Emitter {
  constructor() {
    this.listeners = new Map()
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  off(event, listener) {
    const list = this.listeners.get(event)
    if (list === undefined) return this
    this.listeners.set(event, list.filter(item => item !== listener))
    return this
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

/**
 * 把响应块序列（帧行 + 字面量，按到达顺序）拆成帧文本与字面量列表。
 * 只信任块序列：标记 `{n}` 的块之后紧邻的块就是那 n 字节数据（由 onData 保证）。
 * @param {Array<{text: string, literal: boolean}>} chunks
 * @returns {{frame: string, literals: string[]}}
 */
export function parseLiteralChunks(chunks) {
  const frameParts = []
  const literals = []
  for (const chunk of chunks) {
    if (chunk.literal) literals.push(chunk.text)
    else frameParts.push(chunk.text)
  }
  return { frame: frameParts.join(''), literals }
}

/** 从渲染文本里抽字面量（仅诊断用；真实读取走 parseLiteralChunks）。 */
export function extractLiterals(raw) {
  const text = String(raw ?? '')
  const literals = []
  const pattern = /\{(\d+)\}\r?\n/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const bytes = Number(match[1])
    const start = match.index + match[0].length
    literals.push(text.slice(start, start + bytes))
    pattern.lastIndex = start + bytes
  }
  return literals
}

/**
 * 把一条响应行切成顶层 token：加括号分组、引号字符串、原子。
 * @param {string} line
 * @returns {Array<string|string[]>}
 */
export function tokenize(line) {
  const tokens = []
  let index = 0
  const text = String(line ?? '')
  while (index < text.length) {
    const char = text[index]
    if (char === ' ') {
      index++
      continue
    }
    if (char === '(') {
      const [group, next] = readGroup(text, index + 1)
      tokens.push(group)
      index = next
      continue
    }
    if (char === '"') {
      const [value, next] = readQuoted(text, index + 1)
      tokens.push(value)
      index = next
      continue
    }
    const start = index
    while (index < text.length && text[index] !== ' ') index++
    tokens.push(text.slice(start, index))
  }
  return tokens
}

function readQuoted(text, start) {
  let value = ''
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === '\\' && index + 1 < text.length) {
      value += text[index + 1]
      index += 2
      continue
    }
    if (char === '"') return [value, index + 1]
    value += char
    index++
  }
  return [value, index]
}

function readGroup(text, start) {
  const group = []
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === ' ') {
      index++
      continue
    }
    if (char === ')') return [group, index + 1]
    if (char === '(') {
      const [nested, next] = readGroup(text, index + 1)
      group.push(nested)
      index = next
      continue
    }
    if (char === '"') {
      const [value, next] = readQuoted(text, index + 1)
      group.push(value)
      index = next
      continue
    }
    const begin = index
    while (index < text.length && text[index] !== ' ' && text[index] !== ')') index++
    group.push(text.slice(begin, index))
  }
  return [group, index]
}

/** 把 token 还原成可读文本（日志、错误信息与二次解析用）。 */
export function renderTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : []).map((token) => {
    if (Array.isArray(token)) return `(${renderTokens(token)})`
    const text = String(token)
    return /[\s()"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text
  }).join(' ')
}

/** 在 token 序列里按名字取一个括号分组（如 FETCH 的 FLAGS 组）。 */
export function findNamedGroup(tokens, name) {
  for (let index = 0; index < tokens.length; index++) {
    if (String(tokens[index]).toUpperCase() === name.toUpperCase() && Array.isArray(tokens[index + 1])) {
      return tokens[index + 1]
    }
  }
  return undefined
}

/**
 * 取 FETCH 的括号分组并扁平化为 token 列表。
 *
 * 注意：tokenize 会把整个 `(...)` 收成一个嵌套数组，因此「找关键词再取下一个 token」
 * 的写法在真实响应上必然落空（曾导致 UID 解析为空、FETCH 结果被整体丢弃）。
 */
function fetchTokens(raw) {
  const tokens = tokenize(String(raw ?? ''))
  const index = tokens.findIndex(token => String(token).toUpperCase() === 'FETCH')
  if (index < 0) return []
  const group = tokens[index + 1]
  if (!Array.isArray(group)) return []
  return group.flatMap(token => (Array.isArray(token) ? token : [token]))
}

/** 解析 FETCH 响应 → { uid, flags, internalDate, size }；缺字段为 undefined。 */
export function parseFetchResponse(raw) {
  const tokens = fetchTokens(raw)
  const result = {}
  const uidIndex = tokens.findIndex(token => String(token).toUpperCase() === 'UID')
  if (uidIndex >= 0 && tokens[uidIndex + 1] !== undefined) {
    const uid = Number(tokens[uidIndex + 1])
    if (Number.isSafeInteger(uid)) result.uid = uid
  }
  const flagsIndex = tokens.findIndex(token => String(token).toUpperCase() === 'FLAGS')
  if (flagsIndex >= 0) {
    // fetchTokens 会把括号组扁平化，FLAGS 的值不再是一个数组：
    // 收集 FLAGS 之后的连续 token，直到遇到下一个 FETCH 关键字为止（\Seen \Answered 等）。
    const STOP = new Set(['UID', 'INTERNALDATE', 'RFC822.SIZE', 'BODY', 'BODYSTRUCTURE', 'ENVELOPE', 'MODSEQ'])
    const collected = []
    if (Array.isArray(tokens[flagsIndex + 1])) {
      collected.push(...tokens[flagsIndex + 1])
    } else {
      for (let cursor = flagsIndex + 1; cursor < tokens.length; cursor += 1) {
        const token = tokens[cursor]
        if (Array.isArray(token) || STOP.has(String(token).toUpperCase())) break
        collected.push(String(token))
      }
    }
    if (collected.length > 0) result.flags = collected
  }
  const dateIndex = tokens.findIndex(token => String(token).toUpperCase() === 'INTERNALDATE')
  if (dateIndex >= 0 && tokens[dateIndex + 1] !== undefined) result.internalDate = String(tokens[dateIndex + 1])
  const sizeIndex = tokens.findIndex(token => String(token).toUpperCase() === 'RFC822.SIZE')
  if (sizeIndex >= 0) {
    const size = Number(tokens[sizeIndex + 1])
    if (Number.isSafeInteger(size)) result.size = size
  }
  return result
}

/**
 * 按记录好的偏移把字面量塞回帧文本，得到「结构完整」的字符串。
 * BODYSTRUCTURE 里的文件名/参数常以字面量返回，不塞回去结构解析就看不到它们。
 * 偏移记的是帧里 `{n}` **标记的起点**，这里用字面量内容**替换掉 `{n}`（含紧随的换行）**：
 * 只插入不消费标记的话，`tokenize` 会把 `{140}` 当成一个裸 token，参数配对随之错位
 * （`"filename*"` 会被配成 `{140}`，真文件名静默消失）。
 * 必须按偏移而不是按出现顺序：同一响应里可能有多个字面量，结构文本里也会出现 `{123}` 这类数字形态。
 */
export function spliceLiterals(frame, offsets, literals) {
  const text = String(frame ?? '')
  if (!Array.isArray(offsets) || offsets.length === 0 || !Array.isArray(literals)) return text
  let out = ''
  let cursor = 0
  for (let index = 0; index < offsets.length; index++) {
    const at = offsets[index]
    const literal = literals[index]
    if (literal === undefined || at === undefined || at < cursor) continue
    const marker = /^\{\d+\}\r?\n?/.exec(text.slice(at))
    out += text.slice(cursor, at) + literal
    cursor = marker === null ? at : at + marker[0].length
  }
  return out + text.slice(cursor)
}

/** 归一化 SEARCH 响应（兼容 ESEARCH 的 `* ESEARCH (TAG "a1") UID ALL 1:5` 形态）。 */
export function parseSearchTokens(tokens) {
  const uids = []
  const collect = (list) => {
    for (const token of list) {
      if (Array.isArray(token)) {
        collect(token)
        continue
      }
      const text = String(token)
      if (/^\d+$/.test(text)) {
        uids.push(Number(text))
        continue
      }
      if (/^\d+:\d+$/.test(text)) {
        const [from, to] = text.split(':').map(Number)
        const start = Math.min(from, to)
        const end = Math.max(from, to)
        for (let uid = start; uid <= end; uid++) uids.push(uid)
      }
    }
  }
  collect(tokens)
  return [...new Set(uids)]
}

/** 解析 LIST 响应行 → { flags, delimiter, name }（delimiter 为 NIL 时给空串）。 */
export function parseListResponse(raw) {
  const text = String(raw ?? '')
  const tokens = tokenize(text.startsWith('* ') ? text.slice(2) : text)
  const flags = Array.isArray(tokens[1]) ? tokens[1].map(item => String(item)) : []
  const delimiterToken = tokens[2]
  const delimiter = delimiterToken === undefined || delimiterToken === 'NIL' ? '' : String(delimiterToken)
  const name = tokens.slice(3).filter(token => typeof token === 'string').join(' ')
  if (name === '') return null
  // 文件夹名先按 modified UTF-7 解码（真实服务商返回的就是这一形式），
  // 再兜底还原「服务端直接返回裸 UTF-8 字节」的少数实现。
  return { flags, delimiter, name: recoverWireText(decodeMailboxName(name)) }
}

const HEADER_FIELDS = [
  'From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References',
  'Reply-To', 'Return-Path', 'Content-Type', 'Content-Transfer-Encoding', 'Content-Disposition',
]

/**
 * IMAP 连接：connect() → 命令… → logout()。命令串行；任何命令抛错后连接即视为不可用。
 */
export class ImapConnection extends Emitter {
  constructor(options) {
    super()
    this.options = options
    this.buffer = ''
    this.queues = new Map()
    this.current = null
    this.counter = 0
    this.socket = null
    this.selected = null
    this.closed = false
    this.capabilities = []
    /** 当前响应的帧文本（只含协议行，不含字面量内容）。 */
    this.frame = ''
    /** 当前响应的字面量内容（按到达顺序）。 */
    this.bodies = []
    /** 每个字面量在帧文本中的起始偏移（与 bodies 一一对应）。 */
    this.literalAt = []
    /** 正在等待的字面量字节数（null 表示不在字面量中）。 */
    this.pendingLiteral = null
    /** 字面量已收完，正在等它后面那一行续行到齐（真实 TCP 分片常在字面量处断开）。 */
    this.awaitingLiteralTail = false
  }

  /** 建立连接（secure=true 隐式 TLS；明文仅回环/显式放行时由上层闸门允许）。 */
  async connect() {
    const { host, port, secure, timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions = {} } = this.options
    await new Promise((resolve, reject) => {
      let settled = false
      const onReady = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const onError = (error) => {
        if (settled) return
        settled = true
        reject(new MailNetworkError(`无法连接 IMAP 服务器 ${host}:${port}：${error.message}`, { host, cause: error }))
      }
      this.socket = secure
        ? tlsConnect({ host, port, servername: host, ...tlsOptions }, onReady)
        : netConnect({ host, port }, onReady)
      this.socket.setTimeout(timeoutMs)
      this.socket.once('error', onError)
      this.socket.once('timeout', () => {
        const error = new MailNetworkError(`IMAP 服务器 ${host}:${port} 响应超时（${timeoutMs}ms）`, { host })
        this.failAll(error)
        this.socket?.destroy()
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      this.socket.once('close', () => {
        this.closed = true
        this.failAll(new MailNetworkError(`IMAP 连接已断开（${host}:${port}）`, { host }))
        this.emit('close')
      })
      this.socket.on('data', chunk => this.onData(chunk))
    })
    return this
  }

  /**
   * 接收解析：帧行进 `frame`，字面量字节进 `bodies`。
   *
   * 状态机只有三态，且**每条响应的结束点明确**：
   * - 待字面量（pendingLiteral）：上一帧行以 `{n}` 结束，接下来 n 字节原样收下；
   * - 帧行读满一行：以 `{n}` 结尾的转入待字面量；以 `*`/`+` 开头且不带 `{n}` 的
   *   就地结束本条 untagged 响应；带 tag 的完成行结束该命令并把响应交给等待者。
   *
   * 两条历史教训写死在这里，别再退化：
   * 1. 字面量长度按字节记账，绝不从渲染文本反推（服务端的收尾 `)` 不带换行）；
   * 2. 帧与字面量分开存放，调试/解析永远看不到被字面量内容污染的帧文本。
   */
  onData(chunk) {
    this.buffer += chunk.toString('latin1')
    for (;;) {
      if (this.closed) return

      // ① 已声明字面量：读满 n 字节（原样，不做行切分）
      if (this.pendingLiteral !== null) {
        const { bytes, frameAt } = this.pendingLiteral
        // D-4：有的服务商在 `{n}` 声明行与字节之间多发一个空行。它不是字面量内容：按 n 字节
        // 直接切会把这段 CRLF 算进值里，filename 变成 `"\r\n发票…"`，只靠 sanitize 剥控制字符兜底
        // ——属静默写进解析值的框架字节污染。
        //
        // **判据写死：只剥 BODYSTRUCTURE 响应里的空行，别顺手放开到正文/头部字面量。**（2026-09-13 裁决）
        // 1. 这里字面量一定是参数值（文件名），不可能天然以空行开头，剥掉只有收益；
        // 2. 正文/头部字面量的首字节可能真的是 CRLF（如 HEADER.FIELDS 命中为空时整块就是 CRLF），
        //    剥掉会让整个字面量错位 2 字节、静默吃掉紧随的收尾 `)`——同一类污染，且比乱码更难发现；
        // 3. `this.frame` 只堆**帧行**，字面量字节在 `this.bodies`，所以邮件正文里出现
        //    "BODYSTRUCTURE" 这个词不会误判该判据；而 fetchHeaders / fetchSections / fetchFull
        //    的帧里都不含 BODYSTRUCTURE，它们声明的字面量对应正文/头部/部件字节，天然被排除在外。
        // 要放开必须先证明「空行方言」对正文/头部字面量真实存在，并给出不咬掉合法 CRLF 首字节的办法。
        const blankLine = /^(?:\r\n|\n)/.exec(this.buffer)
        if (blankLine !== null && this.frame.includes('BODYSTRUCTURE')) {
          this.buffer = this.buffer.slice(blankLine[0].length)
        }
        if (this.buffer.length < bytes) return
        this.bodies.push(this.buffer.slice(0, bytes))
        this.literalAt.push(frameAt)
        this.buffer = this.buffer.slice(bytes)
        this.pendingLiteral = null
        // 字面量之后的换行统一交给 ①b 处理（它本来就会先剥一个 `^\r?\n`），这里不再提前剥。
        // 续行交给 ①b：真实 TCP 分片常在字面量处断开，必须等整行到齐再收
        this.awaitingLiteralTail = true
        continue
      }

      // ①b 字面量之后的续行：整行到齐才消费，且不能把「下一条响应」吞进本响应
      if (this.awaitingLiteralTail) {
        // 形态②的换行可能比字面量晚到（分片），在这里补吃；形态①直接是续行内容
        const lineBreak = /^\r?\n/.exec(this.buffer)
        if (lineBreak !== null) this.buffer = this.buffer.slice(lineBreak[0].length)
        const tailEnd = this.buffer.indexOf('\n')
        if (tailEnd < 0) return
        const rawTail = this.buffer.slice(0, tailEnd)
        const tail = rawTail.endsWith('\r') ? rawTail.slice(0, -1) : rawTail
        this.awaitingLiteralTail = false
        const nextResponse = /^\*(\s|$)/.test(tail) || /^\+/.test(tail) || /^\S+\s+(OK|NO|BAD)\b/i.test(tail)
        if (!nextResponse) {
          this.buffer = this.buffer.slice(tailEnd + 1)
          this.frame += tail
          // 同一条响应里可能有多个字面量（一封邮件多个附件）：续行又以 `{n}` 结尾就继续等字节，
          // 不能提前交付——否则一条 FETCH 会被切成数条残缺响应。
          const declaredAgain = /\{(\d+)\}$/.exec(this.frame)
          if (declaredAgain !== null) {
            const next = Number(declaredAgain[1])
            if (next > MAX_LITERAL_BYTES) {
              this.fail(new MailProtocolError(`服务器要求的字面量过大（${next} 字节），已中止读取`))
              return
            }
            this.pendingLiteral = { bytes: next, frameAt: this.frame.length - declaredAgain[0].length }
            continue
          }
        }
        this.deliver({ kind: 'untagged' })
        continue
      }

      // ② 读一整行
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const rawLine = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') continue

      // ③ 行尾 `{n}`：字面量声明，收进帧后转入 ①
      const declared = /\{(\d+)\}$/.exec(line)
      if (declared !== null) {
        const bytes = Number(declared[1])
        if (bytes > MAX_LITERAL_BYTES) {
          this.fail(new MailProtocolError(`服务器要求的字面量过大（${bytes} 字节），已中止读取`))
          return
        }
        this.frame += `${line}${CRLF}`
        // 字面量在帧里的起点 = 本行 `{n}` 标记的位置（spliceLiterals 会用字面量替换掉这段标记）。
        // 记成帧首/帧尾都会让结构解析错位：这是 IMAP 收包热路径，fetchHeaders/fetchSections 也吃它。
        this.pendingLiteral = { bytes, frameAt: this.frame.length - CRLF.length - declared[0].length }
        continue
      }

      this.frame += `${line}${CRLF}`
      const code = line.charCodeAt(0)
      if (code === 43) { // '+'
        const request = this.current
        if (request !== null) request.continuation = line
        this.frame = ''
        this.bodies = []
        this.emit('continuation', line)
        continue
      }
      if (code === 42) { // '*'
        this.deliver({ kind: 'untagged' })
        continue
      }
      const tagged = /^(\S+)\s+(OK|NO|BAD)\b\s*(.*)$/i.exec(line)
      if (tagged === null) {
        this.deliver({ kind: 'other' })
        continue
      }
      this.deliver({ kind: 'tagged', tag: tagged[1], status: tagged[2].toUpperCase(), text: tagged[3] })
    }
  }

  deliver(outcome) {
    const frame = this.frame.endsWith(CRLF) ? this.frame.slice(0, -CRLF.length) : this.frame
    // literalAt：每个字面量在帧文本里的起点（帧里对应 `{n}` 标记的 `{` 那一位，
    // spliceLiterals 会用字面量替换掉整段标记）。
    // 结构与文件名常以字面量返回，解析时要按位置塞回去，不能按出现顺序猜。
    const literalAt = this.literalAt.slice()
    const response = { response: frame, literals: this.bodies, literalAt, responseWithLiterals: spliceLiterals(frame, literalAt, this.bodies) }
    this.frame = ''
    this.bodies = []
    this.literalAt = []
    if (outcome.kind === 'untagged') {
      const request = this.current
      if (request !== null) request.responses.push(response)
      return
    }
    if (outcome.kind === 'other') {
      this.emit('unknown', response.response)
      return
    }
    const request = this.queues.get(outcome.tag)
    if (request === undefined) {
      this.emit('unknown', response.response)
      return
    }
    request.responses.push(response)
    this.queues.delete(outcome.tag)
    this.current = null
    if (outcome.status === 'OK') request.resolve({ status: 'OK', text: outcome.text, responses: request.responses })
    else request.reject(new MailProtocolError(`IMAP 命令被拒绝（${this.options.host}）：${outcome.status} ${outcome.text}`.trim()))
  }

  fail(error) {
    this.failAll(error)
    this.socket?.destroy()
  }

  failAll(error) {
    for (const request of this.queues.values()) {
      if (!request.settled) {
        request.settled = true
        request.reject(error)
      }
    }
    this.queues.clear()
    this.current = null
  }

  /** 发一条命令（命令串行：调用方 await，队列里最多一条在飞）。 */
  command(parts, options = {}) {
    if (this.closed || this.socket === null) {
      return Promise.reject(new MailNetworkError(`IMAP 连接不可用（${this.options.host}）`, { host: this.options.host }))
    }
    const tag = `a${++this.counter}`
    const request = { tag, settled: false, responses: [], continuation: null, resolve: () => {}, reject: () => {} }
    const promise = new Promise((resolve, reject) => {
      request.resolve = (value) => {
        request.settled = true
        resolve(value)
      }
      request.reject = (error) => {
        request.settled = true
        reject(error)
      }
    })
    this.queues.set(tag, request)
    this.current = request
    const suffix = options.literalBytes === undefined ? '' : ` {${options.literalBytes}}`
    this.write(`${tag} ${parts.join(' ')}${suffix}${CRLF}`)
    return promise
  }

  write(text) {
    try {
      this.socket?.write(Buffer.from(toWire(text), 'latin1'))
    } catch (error) {
      throw new MailNetworkError(`向 IMAP 服务器写入失败：${error.message}`, { host: this.options.host, cause: error })
    }
  }

  /** 读取能力列表（CAPABILITY）。 */
  async capability() {
    const response = await this.command(['CAPABILITY'])
    const line = response.responses.find(item => /^\* CAPABILITY/i.test(item.response))
    this.capabilities = line === undefined
      ? []
      : line.response.replace(/^\* CAPABILITY\s*/i, '').trim().split(/\s+/).map(token => token.toUpperCase())
    return this.capabilities
  }

  /**
   * 登录：先试 AUTHENTICATE PLAIN（凭据不进命令回显），被服务端拒绝则回退 LOGIN（TLS 内）。
   *
   * 回退不是可选项：163/Coremail 声明 AUTH=PLAIN 却对 SASL-IR 形式回 `BAD Request not ending with`，
   * 只有 LOGIN 能过；而有些服务商反过来只认 AUTH。两条都失败才报错，错误里带两次尝试的结果。
   * 登录成功后按需发 ID（QQ/163 要求客户端自报身份，否则会被判「不安全登录」）。
   */
  async login(user, password) {
    const capabilities = this.capabilities.length > 0 ? this.capabilities : await this.capability()
    let method = ''
    let authError
    if (capabilities.includes('AUTH=PLAIN')) {
      let rejected
      try {
        const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')
        const promise = this.command(['AUTHENTICATE', 'PLAIN'])
        // 服务端可能在续行之前就直接拒（163 回 BAD）：必须与「等续行」竞速，
        // 否则会白等一个超时周期才回退 LOGIN。
        promise.catch((error) => { rejected = error })
        const continuation = await Promise.race([
          this.waitContinuation(),
          promise.then(() => undefined, () => undefined),
        ])
        if (continuation === undefined) {
          await promise
        } else {
          this.write(`${token}${CRLF}`)
          await promise
        }
        method = 'AUTHENTICATE PLAIN'
      } catch (error) {
        if (!(error instanceof MailProtocolError)) throw error
        authError = error
      }
      void rejected
    }
    if (method === '') {
      try {
        await this.command(['LOGIN', quoteImapString(user), quoteImapString(password)])
        method = 'LOGIN'
      } catch (error) {
        if (authError !== undefined && error instanceof MailProtocolError) {
          throw new MailProtocolError(`邮箱登录失败：AUTHENTICATE PLAIN 与 LOGIN 均被拒绝（先：${authError.message}；后：${error.message}）`, { cause: error })
        }
        throw error
      }
    }
    await this.identify()
    return method
  }

  /**
   * 发 ID 命令自报客户端身份（RFC 2971）。QQ/163 登录后必须发，否则读信会报
   * `Unsafe Login`；不支持的服务商回 BAD，按「非致命」处理，不影响已建立的会话。
   */
  async identify() {
    const capabilities = this.capabilities.length > 0 ? this.capabilities : await this.capability()
    if (!capabilities.includes('ID')) return false
    try {
      await this.command(['ID', '("name"', '"lawyer-desk"', '"version"', '"0.1.0"', '"vendor"', '"codingrui"', '"support"', '"model.codingrui.work")'])
      return true
    } catch {
      return false
    }
  }

  /** 等当前命令的 `+` 续行（SASL 与 APPEND 共用）。 */
  waitContinuation() {
    const request = this.current
    if (request === null) return Promise.reject(new MailProtocolError('IMAP 连接上没有在飞的命令'))
    if (request.continuation !== null) return Promise.resolve(request.continuation)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('continuation', onContinuation)
        reject(new MailProtocolError(`IMAP 服务器未在超时内发送续行（${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`))
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      // 不把定时器算作「有事可做」：命令先被拒（服务端回 BAD）时这个定时器还挂着，
      // 会让整个进程在该路径上一直不退出（测试表现为「用例通过但文件超时」）。
      timer.unref?.()
      const onContinuation = (line) => {
        clearTimeout(timer)
        this.off('continuation', onContinuation)
        resolve(line)
      }
      this.on('continuation', onContinuation)
    })
  }

  /** 列文件夹。 */
  async listFolders() {
    const response = await this.command(['LIST', '""', '"*"'])
    return response.responses
      .filter(item => /^\* (LIST|LSUB)\b/i.test(item.response))
      .map(item => parseListResponse(item.response.split(/\r?\n/)[0]))
      .filter(item => item !== null)
  }

  /** 选中文件夹（邮箱名按 modified UTF-7 编码，中文文件夹才能在真实服务商上打开）。 */
  async select(mailbox) {
    const name = quoteImapString(encodeMailboxName(mailbox))
    let response
    try {
      response = await this.command(['SELECT', name])
    } catch (error) {
      if (error instanceof MailProtocolError) {
        throw new MailProtocolError(`无法打开邮件夹「${mailbox}」：${error.message}`, { cause: error })
      }
      throw error
    }
    this.selected = mailbox
    const texts = response.responses.map(item => item.response)
    const countMatch = texts.map(text => /^\* (\d+) EXISTS/i.exec(text)).find(match => match !== null)
    const uidValidityMatch = texts.map(text => /UIDVALIDITY\s+(\d+)/i.exec(text)).find(match => match !== null)
    return {
      mailbox,
      exists: countMatch === undefined || countMatch === null ? 0 : Number(countMatch[1]),
      uidValidity: uidValidityMatch === undefined || uidValidityMatch === null ? '' : uidValidityMatch[1],
      readOnly: /\[READ-ONLY\]/i.test(response.text),
    }
  }

  /**
   * UID SEARCH。
   * @param {string} criteria 已构造好的 IMAP 搜索串（调用方保证无 CR/LF）
   */
  async search(criteria) {
    const query = String(criteria ?? '').trim()
    const response = await this.command(['UID', 'SEARCH', ...(query === '' ? ['ALL'] : query.split(/\s+/).filter(Boolean))])
    const texts = response.responses.map(item => item.response)
    const line = texts.find(text => /^\* SEARCH/i.test(text)) ?? texts.find(text => /^\* ESEARCH/i.test(text))
    if (line === undefined) return { uids: [], raw: '' }
    const tokens = tokenize(line.slice(2))
    return { uids: parseSearchTokens(tokens.slice(1)), raw: renderTokens(tokens.slice(1)) }
  }

  /**
   * 取 BODYSTRUCTURE（只读，不下载正文）。返回 [{ uid, structure }]，structure 是原始结构文本。
   */
  async fetchStructures(uids, { chunkSize = 20 } = {}) {
    const results = []
    for (const chunk of chunkUids(uids, chunkSize)) {
      const response = await this.command(['UID', 'FETCH', chunk.join(','), '(BODYSTRUCTURE)'])
      for (const item of response.responses) {
        if (!/^\* \d+ FETCH/i.test(item.response)) continue
        const parsed = parseFetchResponse(item.response)
        if (parsed.uid === undefined) continue
        const text = item.responseWithLiterals
        const at = text.indexOf('BODYSTRUCTURE')
        if (at < 0) {
          results.push({ uid: parsed.uid, structure: '' })
          continue
        }
        // 结构本体按**括号配对**取出，不能盲目 `replace(/\)$/, '')`：
        // 字面量形态的响应里，末尾 `)` 的个数随服务商写法而变（有的把 FETCH 收尾的 `)` 算进来，
        // 有的不算），少切一位就少一个括号、多切一位就丢掉结构的收尾 → findStructureClose 找不到
        // 配对 → parseBodyStructure 返回 [] → 附件整个下不了（本次 D-1 的第二层原因）。
        const bodyStructureText = text.slice(at + 'BODYSTRUCTURE'.length).trim()
        const structureEnd = findStructureClose(bodyStructureText)
        results.push({ uid: parsed.uid, structure: structureEnd > 0 ? bodyStructureText.slice(0, structureEnd) : bodyStructureText })
      }
    }
    return results
  }

  /** 取一批 UID 的摘要（FLAGS / INTERNALDATE / RFC822.SIZE）。 */
  async fetchSummaries(uids, { chunkSize = 100 } = {}) {
    const summaries = []
    for (const chunk of chunkUids(uids, chunkSize)) {
      const response = await this.command(['UID', 'FETCH', chunk.join(','), '(FLAGS', 'INTERNALDATE', 'RFC822.SIZE)'])
      for (const item of response.responses) {
        if (!/^\* \d+ FETCH/i.test(item.response)) continue
        summaries.push(parseFetchResponse(item.response))
      }
    }
    return summaries
  }

  /** 取信头（BODY.PEEK[HEADER.FIELDS (...)]，不置 \Seen）。 */
  fetchHeaders(uids, options = {}) {
    return this.fetchSections(uids, `BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(' ')})]`, options)
  }

  /** 取整封邮件（BODY.PEEK[]，不置 \Seen）。 */
  fetchFull(uids, options = {}) {
    return this.fetchSections(uids, 'BODY.PEEK[]', options)
  }

  /** 取正文（BODY.PEEK[TEXT]）。 */
  fetchBody(uids, options = {}) {
    return this.fetchSections(uids, 'BODY.PEEK[TEXT]', options)
  }

  /** 取指定 section：返回 [{ uid, flags, internalDate, size, data }]。 */
  async fetchSections(uids, section, { chunkSize = 20, maxBytes = MAX_LITERAL_BYTES } = {}) {
    const results = []
    for (const chunk of chunkUids(uids, chunkSize)) {
      const response = await this.command(['UID', 'FETCH', chunk.join(','), `(${section})`])
      for (const item of response.responses) {
        if (!/^\* \d+ FETCH/i.test(item.response)) continue
        const parsed = parseFetchResponse(item.response)
        if (parsed.uid === undefined) continue
        const data = item.literals.join('')
        if (data.length > maxBytes) throw new MailProtocolError(`邮件过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB），已中止读取`)
        results.push({ uid: parsed.uid, flags: parsed.flags ?? [], internalDate: parsed.internalDate, size: parsed.size, data })
      }
    }
    return results
  }

  /** 置/取消标志（\Seen 等）。 */
  async storeFlags(uids, flags, { mode = 'add' } = {}) {
    const operation = mode === 'remove' ? '-FLAGS' : '+FLAGS'
    for (const chunk of chunkUids(uids, 100)) {
      await this.command(['UID', 'STORE', chunk.join(','), operation, `(${flags.join(' ')})`])
    }
  }

  /** APPEND 一封邮件到指定文件夹（存草稿用）。 */
  async append(mailbox, raw, flags = []) {
    const name = quoteImapString(encodeMailboxName(mailbox))
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
    const flagPart = flags.length > 0 ? `(${flags.join(' ')})` : ''
    const parts = ['APPEND', name, ...(flagPart === '' ? [] : [flagPart])]
    const promise = this.command(parts, { literalBytes: bytes.length })
    await this.waitContinuation()
    this.write(`${bytes.toString('latin1')}${CRLF}`)
    await promise
    return { mailbox, bytes: bytes.length }
  }

  /** 优雅退出；已断开时静默。 */
  async logout() {
    if (this.closed || this.socket === null) return
    try {
      await this.command(['LOGOUT'])
    } catch {
      // 退出失败不影响调用结果
    } finally {
      this.closed = true
      this.socket.end()
      this.socket.destroy()
    }
  }
}

/**
 * 找到一个括号分组的结束位置（跳过引号串与嵌套括号）。
 * @param {string} text 从 '(' 开始的结构文本
 * @returns {number} 结束下标（')' 之后一位），找不到返回 -1
 */
export function findStructureClose(text) {
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index++
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === '"') { index++; break }
        index++
      }
      continue
    }
    if (char === '(') depth++
    if (char === ')') {
      depth--
      if (depth === 0) return index + 1
    }
    index++
  }
  return -1
}

/** 从 BODYSTRUCTURE 的一小段里取参数数组（如 ("charset" "UTF-8")）→ 对象。 */
function structureParams(token) {
  const params = {}
  if (!Array.isArray(token)) return params
  for (let index = 0; index + 1 < token.length; index += 2) {
    const key = String(token[index]).toLowerCase()
    params[key] = String(token[index + 1])
  }
  return params
}

/**
 * 部件参数里的附件名：优先 RFC 2231 扩展参数 `filename*`/`name*`（charset'lang'percent），
 * 其余交给 decodeAttachmentFilename（RFC 2047 encoded-word / 裸 UTF-8 / 裸 GBK 同一套判定）。
 * 少数服务商（腾讯/网易实测常见）在 BODYSTRUCTURE 里直接回 `filename*`，只认 `filename`
 * 会取不到名字，最终落盘成 `attachment-1.pdf`。
 */
function attachmentName(dispositionParams, params) {
  const extended = dispositionParams['filename*'] ?? params['name*'] ?? ''
  if (extended !== '') return decodeRfc2231Value(extended)
  return decodeAttachmentFilename(dispositionParams.filename ?? params.name ?? '')
}

/** 单个部件（叶子）的元信息。 */
function leafInfo(tokens, path) {
  const type = String(tokens[0] ?? 'application')
  const subtype = String(tokens[1] ?? 'octet-stream')
  const params = structureParams(tokens[2])
  const encoding = typeof tokens[5] === 'string' ? tokens[5].toLowerCase() : ''
  const sizeToken = tokens[6]
  const size = typeof sizeToken === 'string' && /^\d+$/.test(sizeToken) ? Number(sizeToken) : 0
  const dispositionToken = tokens[8]
  const disposition = Array.isArray(dispositionToken) ? String(dispositionToken[0] ?? '').toLowerCase() : ''
  const dispositionParams = Array.isArray(dispositionToken) ? structureParams(dispositionToken[1]) : {}
  // 文件名按线上字节还原成 UTF-8 文本（与头部/文件夹名同一套判定）
  const filename = attachmentName(dispositionParams, params)
  return {
    path,
    contentType: `${type}/${subtype}`.toLowerCase(),
    encoding,
    /** 服务端报的大小（传输编码后的字节数；base64 会大 4/3 左右）。 */
    size,
    /**
     * 解码后大小：与落盘字节、服务商网页显示一致，给律师看的是这个。
     * 用结构文本里该部件紧随的字面量长度换算（服务端报的 size 含换行/边界，直接按它换算会偏大）。
     */
    decodedSize: encoding === 'base64' && size > 0 ? Math.floor(size * 3 / 4) : size,
    disposition,
    filename,
    /** 服务器明确标了 attachment 才算附件（内嵌图片多为 inline + content-id）。 */
    isAttachment: disposition === 'attachment',
    inline: disposition === 'inline',
    contentId: typeof tokens[3] === 'string' && tokens[3] !== 'NIL' ? tokens[3].replace(/^<|>$/g, '') : '',
  }
}

/**
 * 解析 BODYSTRUCTURE 响应（RFC 3501 §7.4.2）为部件清单。
 *
 * 为什么需要它：只看信头的 `multipart/mixed` 会把「纯 HTML + 无附件」的营销邮件
 * 误判成有附件（真实验收里 40 封有 8 封误报）；BODYSTRUCTURE 是服务端给出的权威结构，
 * 还能给出精确的部件路径（下载附件可以只取那一段，不必拉整封）。
 * @param {string} structure 形如 `((("text" "plain" ...) "alternative" ...) "mixed" ...)` 的结构文本
 * @returns {Array<object>} 叶子部件清单（path 为 IMAP 部件号，如 '2'、'1.2'）
 */
export function parseBodyStructure(structure) {
  const text = String(structure ?? '').trim()
  if (text === '' || text[0] !== '(') return []
  const end = findStructureClose(text)
  if (end < 0) return []
  const tokens = tokenize(text.slice(1, end - 1))
  const parts = []
  const walk = (list, prefix) => {
    if (!Array.isArray(list) || list.length === 0) return
    const isMultipart = Array.isArray(list[0])
    if (isMultipart) {
      let index = 0
      let partNumber = 1
      while (index < list.length && Array.isArray(list[index])) {
        walk(list[index], prefix === '' ? String(partNumber) : `${prefix}.${partNumber}`)
        partNumber++
        index++
      }
      return
    }
    parts.push(leafInfo(list, prefix === '' ? '1' : prefix))
  }
  const isMultipart = Array.isArray(tokens[0])
  if (isMultipart) {
    let index = 0
    let partNumber = 1
    while (index < tokens.length && Array.isArray(tokens[index])) {
      walk(tokens[index], String(partNumber))
      partNumber++
      index++
    }
  } else {
    walk(tokens, '1')
  }
  return parts
}

/** UID 列表分块。 */
export function chunkUids(uids, size) {
  const chunks = []
  for (let index = 0; index < uids.length; index += size) chunks.push(uids.slice(index, index + size))
  return chunks
}
