/**
 * 最小 SMTP 客户端（纯协议实现，只依赖 node:net / node:tls，不依赖 cordis / dsh 包）。
 *
 * 只做一件事：把一封已经构造好的 MIME 报文投递给发件服务器。
 * - 支持隐式 TLS（465）与 STARTTLS（587/25，默认强制升级，明文降级需显式放行）；
 * - 认证支持 AUTH PLAIN 与 AUTH LOGIN（中文邮箱服务商普遍支持其一）；
 * - 多行响应按 `250-`（续行）/ `250 `（结束）拼装，4xx/5xx 抛 MailProtocolError（带服务端原文）；
 * - DATA 阶段做点填充（行首 `.` → `..`），确保正文里的点行不会被当成结束标记。
 *
 * 安全：报文头部由 mime.js 的 buildMail 生成并已拦换行注入；SMTP 命令行只放 ASCII 地址。
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { MailNetworkError, MailProtocolError } from './errors.js'
import { toWire } from './validate.js'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT_MS = 45000
/** SMTP 单次响应最长等待（服务端在 DATA 后可能思考较久）。 */
const DATA_TIMEOUT_MS = 120000

/** 解析一行 SMTP 响应：返回 { code, text, more }（more=true 表示还有续行）。 */
export function parseSmtpLine(line) {
  const match = /^(\d{3})([- ])(.*)$/.exec(String(line ?? ''))
  if (match === null) return null
  return { code: Number(match[1]), more: match[2] === '-', text: match[3] }
}

/** 把 4xx/5xx 响应翻译成给律师看的中文原因。 */
export function describeSmtpFailure(code, text) {
  const detail = String(text ?? '').trim()
  // 163/网易的反垃圾拒信：DT:SPM 是内容/附件触发的风控，不是账号或网络问题，
  // 必须给出「怎么改」而不是把英文码丢给律师（真实验收中 .exe 附件触发过）。
  if (code === 554 && /DT:SPM/i.test(detail)) {
    return `邮箱服务商的反垃圾策略拒收了这封邮件（554 DT:SPM）。多为附件类型或正文内容触发：`
      + `请去掉可执行/压缩包类附件、简化正文后重发；若仍失败，可在网页版邮箱里发一次确认账号未被限制`
  }
  if (code === 535 || code === 534) return `邮箱服务商拒绝登录（${code}）：${detail}——通常是授权码错误或未开启 SMTP 服务`
  if (code === 550 || code === 551 || code === 553) return `邮箱服务商拒绝收件人（${code}）：${detail}——请核对收件人地址`
  if (code === 552 || code === 554) return `邮箱服务商拒绝投递（${code}）：${detail}`
  if (code === 421 || code === 450 || code === 451 || code === 452) return `邮箱服务商暂时拒绝（${code}）：${detail}——稍后可重试`
  return `邮箱服务商返回错误（${code}）：${detail}`
}

/** DATA 阶段的点填充（RFC 5321 §4.5.2）。 */
export function dotStuff(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '')
  return text.replace(/\r?\n\./g, `${CRLF}..`).replace(/^\./, '..')
}

/**
 * SMTP 会话：connect() → ehlo() →（STARTTLS）→ auth() → send() → quit()。
 * 一步失败即整段失败：不做静默重试（发信是越界写，重试可能造成重复投递）。
 */
export class SmtpConnection {
  constructor(options) {
    this.options = options
    this.socket = null
    this.buffer = ''
    this.pending = null
    this.closed = false
    this.capabilities = []
    /** 当前响应的续行累积（`250-` 段）。 */
    this.lines = []
  }

  async connect() {
    const { host, port, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    await this.openSocket({ secure: this.options.secure === true })
    const greeting = await this.readResponse(timeoutMs)
    if (greeting.code !== 220) throw new MailProtocolError(describeSmtpFailure(greeting.code, greeting.text))
    return this
  }

  openSocket({ secure }) {
    const { host, port, timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions = {} } = this.options
    return new Promise((resolve, reject) => {
      let settled = false
      const onError = (error) => {
        if (settled) return
        settled = true
        reject(new MailNetworkError(`无法连接 SMTP 服务器 ${host}:${port}：${error.message}`, { host, cause: error }))
      }
      const onReady = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const socket = secure
        ? tlsConnect({ host, port, servername: host, ...tlsOptions }, onReady)
        : netConnect({ host, port }, onReady)
      socket.setTimeout(timeoutMs)
      // 常驻 error 监听：连接关闭后仍可能有异步错误（ECONNRESET / write after end），
      // 没有监听器会以未处理异常炸掉整个进程（曾表现为「发信成功但工具报 write after end」）。
      socket.on('error', (error) => {
        if (!settled) onError(error)
      })
      socket.once('timeout', () => {
        const error = new MailNetworkError(`SMTP 服务器 ${host}:${port} 响应超时（${timeoutMs}ms）`, { host })
        socket.destroy()
        if (!settled) {
          settled = true
          reject(error)
        }
        if (this.pending !== null) {
          const pending = this.pending
          this.pending = null
          pending.reject(error)
        }
      })
      socket.once('close', () => {
        this.closed = true
        if (this.pending !== null) {
          const pending = this.pending
          this.pending = null
          pending.reject(new MailNetworkError(`SMTP 连接已断开（${host}:${port}）`, { host }))
        }
      })
      socket.on('data', chunk => this.onData(chunk))
      this.socket = socket
    })
  }

  onData(chunk) {
    this.buffer += chunk.toString('latin1')
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const rawLine = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      const parsed = parseSmtpLine(line)
      if (parsed === null) continue
      this.lines.push(parsed)
      if (parsed.more) continue
      const pending = this.pending
      this.pending = null
      const lines = this.lines
      this.lines = []
      if (pending !== null) {
        pending.resolve({
          code: parsed.code,
          text: lines.map(item => item.text).join(' ').trim(),
          lines: lines.map(item => `${item.code}${item.more ? '-' : ' '}${item.text}`),
        })
      }
      return
    }
  }

  readResponse(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new MailNetworkError(`SMTP 服务器未在 ${timeoutMs}ms 内响应`, { host: this.options.host }))
      }, timeoutMs)
      timer.unref?.()
      this.pending = {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  write(text) {
    const socket = this.socket
    if (this.closed || socket === null || socket.destroyed === true || socket.writable === false) {
      throw new MailNetworkError(`SMTP 连接已关闭，无法发送（${this.options.host}）`, { host: this.options.host })
    }
    try {
      socket.write(Buffer.from(toWire(text), 'latin1'))
    } catch (error) {
      throw new MailNetworkError(`向 SMTP 服务器写入失败：${error.message}`, { host: this.options.host, cause: error })
    }
  }

  /** 发一条命令并等响应；expect 为允许的成功码（默认 2xx/3xx）。 */
  async command(line, { expect = [250, 220, 235, 334, 354, 251, 252], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.write(`${line}${CRLF}`)
    const response = await this.readResponse(timeoutMs)
    if (!expect.includes(response.code)) throw new MailProtocolError(describeSmtpFailure(response.code, response.text))
    return response
  }

  /** EHLO（失败回落 HELO），并记录能力列表。 */
  async ehlo(clientName = 'lawyer-desk.local') {
    this.write(`EHLO ${clientName}${CRLF}`)
    let response = await this.readResponse()
    if (response.code !== 250) {
      this.write(`HELO ${clientName}${CRLF}`)
      response = await this.readResponse()
      if (response.code !== 250) throw new MailProtocolError(describeSmtpFailure(response.code, response.text))
      this.capabilities = []
      return this.capabilities
    }
    // 能力按 token 展开：服务端的 `AUTH PLAIN LOGIN` 必须能被 `PLAIN` 单独命中
    //（整行当一项会让 AUTH PLAIN 判定失败，退化成 AUTH LOGIN——兼容性更差的路径）。
    this.capabilities = response.lines.slice(1)
      .flatMap(line => line.slice(4).trim().toUpperCase().split(/\s+/))
      .filter(item => item !== '')
    return this.capabilities
  }

  /** STARTTLS：显式加密升级（587/25 的标准路径）。 */
  async startTls() {
    if (!this.capabilities.includes('STARTTLS')) {
      throw new MailProtocolError('邮箱服务商不支持 STARTTLS：请改用 465 端口的隐式加密，或联系管理员')
    }
    this.buffer = ''
    this.lines = []
    await this.command('STARTTLS', { expect: [220] })
    const { host, tlsOptions = {} } = this.options
    const plain = this.socket
    await new Promise((resolve, reject) => {
      const secure = tlsConnect({ socket: plain, servername: host, ...tlsOptions }, resolve)
      secure.once('error', error => reject(new MailNetworkError(`STARTTLS 握手失败：${error.message}`, { host, cause: error })))
      secure.on('data', chunk => this.onData(chunk))
      this.socket = secure
    })
    // 升级后必须重新 EHLO（RFC 3207）
    await this.ehlo()
    return this
  }

  /** 认证：AUTH PLAIN 优先，其次 AUTH LOGIN；服务端都未声明时按 LOGIN 试一次。 */
  async auth(user, password) {
    if (this.capabilities.includes('AUTH=PLAIN') || this.capabilities.includes('PLAIN')) {
      const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')
      await this.command(`AUTH PLAIN ${token}`, { expect: [235] })
      return 'PLAIN'
    }
    await this.command('AUTH LOGIN', { expect: [334, 235] })
    await this.command(Buffer.from(user, 'utf8').toString('base64'), { expect: [334] })
    await this.command(Buffer.from(password, 'utf8').toString('base64'), { expect: [235] })
    return 'LOGIN'
  }

  /**
   * 投递一封报文。
   * @param {{from: string, to: string[], raw: Buffer|string}} message
   * @returns {{accepted: string[], response: string, bytes: number}}
   */
  async send(message) {
    const from = String(message.from ?? '')
    const to = Array.isArray(message.to) ? message.to.filter(item => item !== '') : []
    if (from === '' || to.length === 0) throw new MailProtocolError('发信缺少发件人或收件人')
    await this.command(`MAIL FROM:<${from}>`, { expect: [250] })
    const accepted = []
    for (const recipient of to) {
      const response = await this.command(`RCPT TO:<${recipient}>`, { expect: [250, 251] })
      accepted.push(recipient)
      void response
    }
    const raw = Buffer.isBuffer(message.raw) ? message.raw : Buffer.from(String(message.raw ?? ''), 'utf8')
    await this.command('DATA', { expect: [354] })
    this.write(`${dotStuff(raw)}${CRLF}.${CRLF}`)
    const final = await this.readResponse(DATA_TIMEOUT_MS)
    if (final.code !== 250) throw new MailProtocolError(describeSmtpFailure(final.code, final.text))
    return { accepted, response: final.text, bytes: raw.length }
  }

  /** 结束会话（QUIT 失败不抛错）。 */
  async quit() {
    if (this.closed || this.socket === null || this.socket.destroyed === true) return
    try {
      this.write(`QUIT${CRLF}`)
      await this.readResponse(5000)
    } catch {
      // 忽略退出期错误
    } finally {
      this.closed = true
      this.socket.end()
      this.socket.destroy()
    }
  }
}
