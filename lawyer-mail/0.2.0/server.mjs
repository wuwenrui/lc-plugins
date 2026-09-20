#!/usr/bin/env node
/**
 * 律师邮件 · 协议子进程（构建后位于 dist-server/server.mjs，随插件分发，不进 dist/main.js）。
 *
 * 为什么独立进程：渲染产物跑在无 Node 能力的环境（禁 node:net），而 IMAP/SMTP 需要原始 TCP；
 * 于是协议层（同目录 imap.js / smtp.js / mime.js / mime-word.js，移植自 LawyerDesk lawyer-harness，
 * 零依赖 ESM）全部收在 Node 子进程里，渲染侧经宿主 bridge 的 plugin_exec_run 调起本脚本。
 *
 * 运行模式（共用同一 JSONL 协议，与渲染侧 src/protocol.ts 严格一致）：
 * 1. 单次模式（生产路径）：`node server.mjs '<单行 JSON 请求>'`
 *    请求： {"id":"r1","cmd":"search","args":{...}}
 *    执行完向 stdout 打印单行 JSON 响应后退出：
 *    成功： {"id":"r1","ok":true,"result":{...}}
 *    失败： {"id":"r1","ok":false,"error":{"code":"auth","message":"..."}}
 *    （处理期错误也回 ok:false 而不是非零退出，渲染侧统一解析 stdout。）
 * 2. 常驻模式（预留）：不带参数启动，stdin 逐行读请求 → stdout 逐行回响应。
 *    当前宿主 bridge 无 stdin API，此模式仅供后续主线扩展与本地调试。
 *
 * IMAP 每次调用都连接-登录-操作-退出（邮箱操作可接受）；凭据随请求传入，本进程不落盘任何数据。
 * 读信一律 BODY.PEEK（不置 \Seen，不改动对方邮件已读状态）。
 */

import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { ImapConnection } from './imap.js'
import { SmtpConnection } from './smtp.js'
import { buildMail, parseMail } from './mime.js'
import { attachmentBytes, collectExactAttachments, sanitizeFilename, uniqueTarget } from './attachments.js'
import { MailError } from './errors.js'
import {
  assertEmailAddress,
  assertEndpointPolicy,
  assertFolderName,
  assertHost,
  assertPort,
  assertUid,
  isLoopbackHost,
  parseMailDate,
  quoteImapString,
} from './validate.js'

/** 单条命令的网络超时：exec 桥给 30s，这里留 5s 余量做收尾与退出。 */
const COMMAND_TIMEOUT_MS = 25000
/** 读信正文上限（与 Desk lawyer-mail 同值；超出截断并说明）。 */
const MAX_BODY_CHARS = 20000
const SEARCH_DEFAULT_LIMIT = 10
const SEARCH_MAX_LIMIT = 50
/** 服务端检索零命中时的本地兜底扫描窗口（最近 N 封，对齐 Desk 的「163 不支持关键词检索」经验）。 */
const LOCAL_SCAN_UIDS = 50
const BIND_GUIDANCE =
  '通常是授权码错误或未开启 IMAP/SMTP 服务：请到邮箱网页版「设置 → 账户」开启 IMAP/SMTP 并生成授权码（不是网页登录密码）'

function argsFail(message) {
  throw new MailError('args', message)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') argsFail(`缺少必填参数 ${label}（非空字符串）`)
  return value.trim()
}

function endpoint(value, label) {
  if (typeof value !== 'object' || value === null) argsFail(`缺少 ${label}（{host, port, secure}）`)
  const host = assertHost(value.host, `${label}地址`)
  const port = assertPort(value.port, `${label}端口`)
  const secure = value.secure ?? (port === 993 || port === 465)
  if (typeof secure !== 'boolean') argsFail(`${label}的 secure 必须是布尔值`)
  return { host, port, secure }
}

/** IMAP 策略闸：明文仅回环；私网地址放行（企业自建邮件服务器），但公网明文一律拒绝。 */
function imapEndpoint(value) {
  const target = endpoint(value, 'IMAP 服务器')
  return assertEndpointPolicy(target, { allowPrivateHosts: true }, 'IMAP 服务器')
}

/**
 * SMTP 端点策略：secure=false 且非回环时不在此处拒绝——587 端口的标准路径是
 * 明文连接后 STARTTLS 升级（本插件的 SMTP 客户端支持），EHLO 后无 STARTTLS 才拒绝。
 */
function smtpEndpoint(value) {
  return endpoint(value, 'SMTP 服务器')
}

/** 打开一条已登录的 IMAP 连接交给回调，用完必关（连接失败/登录被拒 → 中文错误）。 */
async function withImap(args, callback) {
  const email = requireString(args.email, 'email')
  const authCode = requireString(args.authCode, 'authCode')
  const imap = imapEndpoint(args.imap)
  const connection = new ImapConnection({ ...imap, timeoutMs: COMMAND_TIMEOUT_MS })
  await connection.connect()
  try {
    try {
      await connection.login(email, authCode)
    } catch (error) {
      if (error instanceof MailError && (error.kind === 'protocol' || error.kind === 'auth')) {
        throw new MailError('auth', `邮箱登录被拒绝（${email}）：${error.message}`, { guidance: BIND_GUIDANCE, cause: error })
      }
      throw error
    }
    return await callback(connection, { email, authCode, imap })
  } finally {
    await connection.logout().catch(() => {})
  }
}

/** SMTP 投递一条已构造好的报文（EHLO → 按需 STARTTLS → AUTH → 发送 → QUIT）。 */
async function smtpDeliver(smtp, email, authCode, message) {
  const connection = new SmtpConnection({ ...smtp, timeoutMs: COMMAND_TIMEOUT_MS })
  await connection.connect()
  let authMethod = ''
  try {
    const capabilities = await connection.ehlo('lawyer-copilot.local')
    if (smtp.secure === false && !isLoopbackHost(smtp.host)) {
      if (!capabilities.includes('STARTTLS')) {
        throw new MailError('policy', `SMTP 服务器 ${smtp.host}:${smtp.port} 未提供 STARTTLS：授权码不允许明文外发，请改用 465 端口（SSL）`)
      }
      await connection.startTls()
    }
    try {
      authMethod = await connection.auth(email, authCode)
    } catch (error) {
      if (error instanceof MailError) {
        throw new MailError('auth', `邮箱发信登录被拒绝（${email}）：${error.message}`, { guidance: BIND_GUIDANCE, cause: error })
      }
      throw error
    }
    return { ...await connection.send(message), smtpAuth: authMethod }
  } finally {
    await connection.quit().catch(() => {})
  }
}

/** 把 parsed 邮件的地址对象拼成可读串（"张三 <a@b>" 或 "a@b"）。 */
function addressText(entry) {
  if (entry === null || entry === undefined) return ''
  const name = String(entry.name ?? '').trim()
  const address = String(entry.address ?? '').trim()
  if (name === '') return address
  return `${name} <${address}>`
}

function normalizeDate(raw) {
  const iso = parseMailDate(String(raw ?? ''))
  if (iso !== null) return iso
  return String(raw ?? '')
}

// —————————————————————————— 命令实现 ——————————————————————————

/** test / bind：连通性验证（IMAP 登录+列文件夹，SMTP EHLO+AUTH），不落盘任何数据。 */
async function cmdTest(args) {
  const email = requireString(args.email, 'email')
  const authCode = requireString(args.authCode, 'authCode')
  const imap = imapEndpoint(args.imap)
  const smtp = smtpEndpoint(args.smtp)
  const folders = await withImap(args, async (connection) => connection.listFolders())
  // SMTP 侧只验证到认证为止（不真发信）：connect → EHLO（→STARTTLS）→ AUTH → QUIT。
  const connection = new SmtpConnection({ ...smtp, timeoutMs: COMMAND_TIMEOUT_MS })
  await connection.connect()
  let authMethod = ''
  try {
    const capabilities = await connection.ehlo('lawyer-copilot.local')
    if (smtp.secure === false && !isLoopbackHost(smtp.host)) {
      if (!capabilities.includes('STARTTLS')) {
        throw new MailError('policy', `SMTP 服务器 ${smtp.host}:${smtp.port} 未提供 STARTTLS：授权码不允许明文外发，请改用 465 端口（SSL）`)
      }
      await connection.startTls()
    }
    try {
      authMethod = await connection.auth(email, authCode)
    } catch (error) {
      if (error instanceof MailError) {
        throw new MailError('auth', `邮箱发信登录被拒绝（${email}）：${error.message}`, { guidance: BIND_GUIDANCE, cause: error })
      }
      throw error
    }
  } finally {
    await connection.quit().catch(() => {})
  }
  return {
    verified: true,
    email,
    imap: { host: imap.host, port: imap.port, secure: imap.secure, folders: folders.length },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, authMethod },
  }
}

/** list_folders：列出全部邮件夹（含层级分隔符与是否可读信）。 */
async function cmdListFolders(args) {
  return withImap(args, async (connection) => {
    const folders = await connection.listFolders()
    return {
      folders: folders.map((folder) => ({
        name: folder.name,
        delimiter: folder.delimiter,
        attributes: folder.flags,
        selectable: !folder.flags.some((flag) => /^\\Noselect$/i.test(String(flag))),
      })),
    }
  })
}

/** 搜索：服务端 UID SEARCH（FROM/SUBJECT 命中任一），零命中时对最近 50 封本地过滤兜底。 */
async function cmdSearch(args) {
  const query = requireString(args.query, 'query')
  const folder = assertFolderName(args.folder === undefined ? 'INBOX' : args.folder)
  const limitRaw = args.limit === undefined ? SEARCH_DEFAULT_LIMIT : args.limit
  if (!Number.isInteger(limitRaw) || limitRaw < 1) argsFail('limit 必须是正整数')
  const limit = Math.min(limitRaw, SEARCH_MAX_LIMIT)
  return withImap(args, async (connection) => {
    await connection.select(folder)
    const quoted = quoteImapString(query)
    const { uids } = await connection.search(`OR FROM ${quoted} SUBJECT ${quoted}`)
    let scannedLocally = false
    let ordered = [...uids].sort((left, right) => right - left)
    if (ordered.length === 0) {
      // 兜底：163 免费邮箱等服务端不支持关键词检索时改本地过滤最近邮件（如实标注扫描范围）。
      const all = await connection.search('')
      const recent = [...all.uids].sort((left, right) => right - left).slice(0, LOCAL_SCAN_UIDS)
      if (recent.length > 0) {
        const headers = await connection.fetchHeaders(recent, { chunkSize: 20 })
        const needle = query.toLowerCase()
        ordered = headers
          .filter((item) => {
            const parsed = parseMail(item.data)
            const subject = String(parsed.subject ?? '').toLowerCase()
            const from = addressText(parsed.from).toLowerCase()
            return subject.includes(needle) || from.includes(needle)
          })
          .map((item) => item.uid)
          .sort((left, right) => right - left)
        scannedLocally = true
      }
    }
    const page = ordered.slice(0, limit)
    if (page.length === 0) {
      return { folder, total: ordered.length, scannedLocally, scannedCount: 0, messages: [] }
    }
    const headers = await connection.fetchHeaders(page, { chunkSize: 20 })
    const summaries = new Map((await connection.fetchSummaries(page)).map((item) => [item.uid, item]))
    const timeOf = (uid, data) => {
      const internal = Date.parse(summaries.get(uid)?.internalDate ?? '')
      if (Number.isFinite(internal)) return internal
      const header = Date.parse(parseMail(data).date ?? '')
      return Number.isFinite(header) ? header : 0
    }
    const byUid = new Map(headers.map((item) => [item.uid, item]))
    const messages = page
      .map((uid) => {
        const entry = byUid.get(uid)
        if (entry === undefined) return null
        const parsed = parseMail(entry.data)
        const summary = summaries.get(uid)
        return {
          uid,
          from: addressText(parsed.from),
          to: parsed.to.map(addressText).join(', '),
          subject: parsed.subject,
          date: normalizeDate(parsed.date ?? summary?.internalDate ?? ''),

          size: summary?.size ?? 0,
        }
      })
      .filter((item) => item !== null)
      .sort((left, right) => timeOf(right.uid, byUid.get(right.uid)?.data ?? '') - timeOf(left.uid, byUid.get(left.uid)?.data ?? ''))
    return { folder, total: ordered.length, scannedLocally, scannedCount: scannedLocally ? page.length : 0, messages }
  })
}

/** 读一封信：整封 BODY.PEEK[] 取回并解析；附件只列名（附件字节不进入对话上下文）。 */
async function cmdRead(args) {
  const uid = assertUid(args.uid, 'uid')
  const folder = assertFolderName(args.folder === undefined ? 'INBOX' : args.folder)
  return withImap(args, async (connection) => {
    await connection.select(folder)
    const [fetched] = await connection.fetchFull([uid])
    if (fetched === undefined) {
      throw new MailError('args', `邮件夹「${folder}」里没有 uid=${uid} 的邮件（可能已被移动或删除）`)
    }
    const parsed = parseMail(fetched.data, { maxTextChars: MAX_BODY_CHARS })
    const attachments = parsed.attachments
      .filter((item) => item.inline !== true)
      .map((item) => ({ filename: item.filename, contentType: item.contentType, size: item.size }))
    const text = parsed.truncated
      ? `${parsed.bodyText}\n\n[正文过长，已截断到 ${MAX_BODY_CHARS} 字；需要全文请让律师在邮箱里查看]`
      : parsed.bodyText
    return {
      folder,
      uid,
      subject: parsed.subject,
      from: addressText(parsed.from),
      fromAddress: parsed.from?.address ?? '',
      to: parsed.to.map(addressText).join(', '),
      cc: parsed.cc.map(addressText).join(', '),
      date: normalizeDate(parsed.date ?? fetched.internalDate ?? ''),
      messageId: parsed.messageId,
      text,
      htmlAvailable: parsed.html !== '',
      attachments,
    }
  })
}

/** 发信（真实 SMTP 投递）：confirm 必须显式为 true——与渲染侧 mail_send 工具双重闸门。 */
async function cmdSend(args) {
  if (args.confirm !== true) {
    argsFail('发信需要明确确认：请让律师确认后以 confirm=true 重试')
  }
  const email = requireString(args.email, 'email')
  const authCode = requireString(args.authCode, 'authCode')
  const smtp = smtpEndpoint(args.smtp)
  const to = assertEmailAddress(requireString(args.to, 'to'), '收件人 to')
  const subject = requireString(args.subject, 'subject')
  const body = requireString(args.body, 'body')
  const built = buildMail({ from: { address: email }, to: [{ address: to }], subject, text: body })
  const delivered = await smtpDeliver(smtp, email, authCode, { from: email, to: [to], raw: built.raw })
  return {
    to,
    subject,
    accepted: delivered.accepted,
    response: delivered.response,
    bytes: delivered.bytes,
    messageId: built.messageId,
    smtpAuth: delivered.smtpAuth,
  }
}

/** 面板用：某邮件夹最新 limit 封摘要（uid 倒序取回，按 INTERNALDATE 倒序呈现）。 */
async function cmdList(args) {
  const folder = assertFolderName(args.folder === undefined ? 'INBOX' : args.folder)
  const limitRaw = args.limit === undefined ? 50 : args.limit
  if (!Number.isInteger(limitRaw) || limitRaw < 1) argsFail('limit 必须是正整数')
  const limit = Math.min(limitRaw, SEARCH_MAX_LIMIT)
  return withImap(args, async (connection) => {
    await connection.select(folder)
    const { uids } = await connection.search('')
    const total = uids.length
    const page = [...uids].sort((left, right) => right - left).slice(0, limit)
    if (page.length === 0) return { folder, total, messages: [] }
    const headers = await connection.fetchHeaders(page, { chunkSize: 20 })
    const summaries = new Map((await connection.fetchSummaries(page)).map((item) => [item.uid, item]))
    const timeOf = (uid, data) => {
      const internal = Date.parse(summaries.get(uid)?.internalDate ?? '')
      if (Number.isFinite(internal)) return internal
      const header = Date.parse(parseMail(data).date ?? '')
      return Number.isFinite(header) ? header : 0
    }
    const byUid = new Map(headers.map((item) => [item.uid, item]))
    const messages = page
      .map((uid) => {
        const entry = byUid.get(uid)
        if (entry === undefined) return null
        const parsed = parseMail(entry.data)
        const summary = summaries.get(uid)
        return {
          uid,
          from: addressText(parsed.from),
          to: parsed.to.map(addressText).join(', '),
          subject: parsed.subject,
          date: normalizeDate(parsed.date ?? summary?.internalDate ?? ''),

          size: summary?.size ?? 0,
        }
      })
      .filter((item) => item !== null)
      .sort((left, right) => timeOf(right.uid, byUid.get(right.uid)?.data ?? '') - timeOf(left.uid, byUid.get(left.uid)?.data ?? ''))
    return { folder, total, messages }
  })
}

/** 下载附件落盘目录：默认「下载」文件夹（不存在则创建）；自定义必须是已存在的目录绝对路径。 */
async function resolveSaveDir(dirInput) {
  if (dirInput === null) {
    const downloads = path.join(homedir(), 'Downloads')
    await mkdir(downloads, { recursive: true })
    return downloads
  }
  if (!dirInput.startsWith('/') || dirInput.includes('..')) {
    argsFail('dir 必须是已存在的目录绝对路径（以 / 开头，不含 ..）')
  }
  const info = await stat(dirInput).catch(() => null)
  if (info === null || !info.isDirectory()) argsFail(`dir 不是已存在的文件夹：${dirInput}`)
  return dirInput
}

/**
 * 下载附件：整封 BODY.PEEK[] 取回 → 字节精确提取（attachments.js）→
 * 文件名按 RFC 2047/2231/裸 GBK 解码并净化 → 落盘（同名自动加序号，不覆盖）。
 * 默认只下真正的附件（disposition=attachment 或带文件名且非内联）；filenames 可精确点名。
 */
async function cmdSaveAttachments(args) {
  const uid = assertUid(args.uid, 'uid')
  const folder = assertFolderName(args.folder === undefined ? 'INBOX' : args.folder)
  const dirInput = typeof args.dir === 'string' && args.dir.trim() !== '' ? args.dir.trim() : null
  const filenames = Array.isArray(args.filenames) ? args.filenames.map((item) => String(item)) : null
  if (filenames !== null && filenames.length === 0) argsFail('filenames 若提供必须是非空数组（要点名的附件名）')
  const dir = await resolveSaveDir(dirInput)
  return withImap(args, async (connection) => {
    await connection.select(folder)
    const [fetched] = await connection.fetchFull([uid])
    if (fetched === undefined) {
      throw new MailError('args', `邮件夹「${folder}」里没有 uid=${uid} 的邮件（可能已被移动或删除）`)
    }
    const parsed = parseMail(fetched.data, { maxTextChars: MAX_BODY_CHARS })
    const candidates = collectExactAttachments(fetched.data).filter((item) => item.inline !== true)
    let targets = candidates
    if (filenames !== null) {
      const missing = []
      targets = filenames
        .map((name) => {
          const hit = candidates.find((item) => item.filename === name || item.rawFilename === name)
          if (hit === undefined) {
            missing.push(name)
            return null
          }
          return hit
        })
        .filter((item) => item !== null)
      if (missing.length > 0) {
        const available = candidates.map((item) => item.filename).join('、')
        throw new MailError('args', `没有名为 ${missing.join('、')} 的附件；这封邮件的附件：${available === '' ? '（无）' : available}`)
      }
    }
    if (targets.length === 0) {
      throw new MailError('args', `这封邮件没有可下载的附件${filenames === null ? '' : '（附件名见 mail_read 结果）'}`)
    }
    const used = new Set()
    const saved = []
    for (const item of targets) {
      const bytes = attachmentBytes(item)
      const safeName = sanitizeFilename(item.filename, item.contentType)
      const exists = (candidate) => used.has(candidate) || existsSync(candidate)
      const target = uniqueTarget(dir, safeName, exists)
      used.add(target)
      await writeFile(target, bytes)
      saved.push({
        filename: item.filename,
        savedAs: path.basename(target),
        path: target,
        bytes: bytes.length,
        contentType: item.contentType,
      })
    }
    return { folder, uid, subject: parsed.subject, dir, saved }
  })
}

// —————————————————————————— RPC 分发 ——————————————————————————
const HANDLERS = {
  test: cmdTest,
  bind: cmdTest,
  list_folders: cmdListFolders,
  list: cmdList,
  search: cmdSearch,
  read: cmdRead,
  save_attachments: cmdSaveAttachments,
  send: cmdSend,
}

/** 处理一条请求（永不抛出）：任何失败都折叠成 {ok:false,error}。 */
async function handleRequest(request) {
  const id = typeof request?.id === 'string' && request.id !== '' ? request.id : 'unknown'
  try {
    if (typeof request !== 'object' || request === null) argsFail('请求必须是 JSON 对象')
    const handler = HANDLERS[request.cmd]
    if (handler === undefined) {
      argsFail(`未知命令 "${String(request.cmd)}"（可用：${Object.keys(HANDLERS).join('、')}）`)
    }
    const args = typeof request.args === 'object' && request.args !== null ? request.args : {}
    const result = await handler(args)
    return { id, ok: true, result }
  } catch (error) {
    if (error instanceof MailError) {
      return { id, ok: false, error: { code: error.kind, message: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { id, ok: false, error: { code: 'internal', message: `邮件子进程内部错误：${message}` } }
  }
}

function parseRequestLine(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

// 单次模式：argv[2] = 单行 JSON 请求 → stdout 单行 JSON 响应 → 退出。
if (process.argv.length >= 3) {
  const raw = process.argv[2]
  let request
  try {
    request = JSON.parse(String(raw))
  } catch {
    process.stdout.write(`${JSON.stringify({ id: 'unknown', ok: false, error: { code: 'args', message: '请求不是合法 JSON（argv[2]）' } })}\n`)
    process.exit(0)
  }
  const response = await handleRequest(request)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  process.exit(0)
}

// 常驻模式（预留）：stdin 逐行请求 → stdout 逐行响应；stdin 结束即退出。
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const parsed = parseRequestLine(line)
  if (parsed === null) continue
  if (parsed === undefined) {
    process.stdout.write(`${JSON.stringify({ id: 'unknown', ok: false, error: { code: 'args', message: '请求行不是合法 JSON' } })}\n`)
    continue
  }
  const response = await handleRequest(parsed)
  process.stdout.write(`${JSON.stringify(response)}\n`)
}
