import http from 'node:http'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { STAGE_ROOT, checkInput, checkOutput, deliverOutput, resolveWpsApp, verifyOfficePackage, verifyPdf } from './runner.mjs'

const HOME = homedir()
const STATE_DIR = path.join(HOME, '.ccgui-next', 'wps-bridge')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const ERROR_FILE = path.join(STATE_DIR, 'error.txt')
const UNCERTAINTY_FILE = path.join(STATE_DIR, 'uncertain.json')
const ADDON_ROOT = path.join(HOME, 'Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons')
const ADDON_DIR = path.join(ADDON_ROOT, 'lawyercopilot-wps_')
const PUBLISH = path.join(ADDON_ROOT, 'publish.xml')
const ENTRY = '  <jsplugin type="wps,et,wpp" url="lawyercopilot-wps_/" enable="true" name="lawyercopilot-wps"/>'
const HOSTS = new Set(['word', 'spreadsheet', 'presentation'])
const WRITE_ACTIONS = new Set(['replace_word', 'append_word', 'insert_table', 'insert_image', 'write_cell', 'add_slide', 'save', 'api_edit', 'export_pdf', 'create_document'])
const MAX_BODY = 64 * 1024
const CONNECTION_TTL = 5000
const HOST_START_WAIT_MS = 75_000
const exec = promisify(execFile)
const DOCUMENT_HOST = new Map([['.docx', 'word'], ['.doc', 'word'], ['.xlsx', 'spreadsheet'], ['.xls', 'spreadsheet'], ['.pptx', 'presentation'], ['.ppt', 'presentation']])
const CREATE_EXTENSION = { word: 'docx', spreadsheet: 'xlsx', presentation: 'pptx' }
export function wpsOpenArgs(file, appPath) { return ['-a', appPath, file] }

function fail(code, message) { const error = new Error(message); error.code = code; return error }
export function requiresConfirmation(action) { return WRITE_ACTIONS.has(action) }
function validStagedOutputPath(value, root, extension) {
  const prefix = `${root}/job-`
  return typeof root === 'string' && typeof value === 'string' && value.startsWith(prefix)
    && new RegExp(`^[A-Za-z0-9-]{6,64}/output\\.${extension}$`).test(value.slice(prefix.length))
}
function validBootstrapStagedPath(value, root, extension) {
  const prefix = `${root}/boot-`
  return typeof root === 'string' && typeof value === 'string' && value.startsWith(prefix)
    && new RegExp(`^[A-Za-z0-9-]{6,64}/bootstrap\\.${extension}$`).test(value.slice(prefix.length))
}
function validStagedImagePath(value, root) {
  const prefix = `${root}/job-`
  return typeof root === 'string' && typeof value === 'string' && value.startsWith(prefix)
    && /^[A-Za-z0-9-]{6,64}\/source\.(?:png|jpg|jpeg)$/.test(value.slice(prefix.length))
}
function validState(value) {
  return value && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535
    && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)
}
async function pluginVersion(assetDir) {
  const direct = path.join(assetDir, 'manifest.json')
  const file = existsSync(direct) ? direct : path.join(assetDir, '..', 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  if (manifest.id !== 'lawyer-wps' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version)) {
    throw fail('ADDON_VERSION_INVALID', 'WPS 插件版本号无效')
  }
  return manifest.version
}
async function existingState() {
  try {
    const value = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return validState(value) ? value : null
  } catch { return null }
}
async function atomicWrite(file, text) {
  const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function mergePublishXml(source) {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<jsplugins>/.test(source) || !/<\/jsplugins>\s*$/.test(source)) {
    throw fail('WPS_CONFIG_INVALID', 'WPS 加载项列表格式无法安全更新')
  }
  const matching = [...source.matchAll(/<jsplugin\b[^>]*>/g)].filter(match => /(?:name=["']lawyercopilot-wps["']|url=["']lawyercopilot-wps_\/["'])/.test(match[0]))
  if (matching.length > 1) throw fail('WPS_CONFIG_CONFLICT', 'WPS 加载项列表存在重复的 LawyerCopilot 条目')
  if (matching.length === 1) {
    const entry = matching[0][0]
    if (/\bname=["']lawyercopilot-wps["']/.test(entry)
        && /\burl=["']lawyercopilot-wps_\/["']/.test(entry)
        && /\btype=["']wps,et,wpp["']/.test(entry)
        && /\benable=["'](?:true|enable_dev)["']/.test(entry)) return source
    throw fail('WPS_CONFIG_CONFLICT', 'WPS 加载项列表中的 LawyerCopilot 条目与当前插件冲突')
  }
  return source.replace(/<\/jsplugins>\s*$/, `${ENTRY}\n</jsplugins>\n`)
}

async function installAddon(assetDir, state) {
  await mkdir(ADDON_ROOT, { recursive: true })
  const current = existsSync(PUBLISH) ? await readFile(PUBLISH, 'utf8')
    : '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n'
  const next = mergePublishXml(current)
  if (existsSync(ADDON_DIR) && !existsSync(path.join(ADDON_DIR, '.lawyercopilot-addon'))) {
    throw fail('WPS_CONFIG_CONFLICT', '同名 WPS 加载项目录不是本插件安装的，已停止')
  }
  const assets = [
    ['addon-manifest.xml', 'manifest.xml'], ['addon-ribbon.xml', 'ribbon.xml'],
    ['addon-index.html', 'index.html'],
  ]
  const wanted = new Map()
  for (const [source, target] of assets) wanted.set(target, await readFile(path.join(assetDir, source)))
  const main = await readFile(path.join(assetDir, 'addon-main.js'), 'utf8')
  if (!main.includes('__LC_WPS_CONFIG__')) throw fail('ADDON_ASSET_INVALID', 'WPS 加载项模板缺少连接参数')
  wanted.set('main.js', Buffer.from(main.replace('__LC_WPS_CONFIG__', JSON.stringify(state))))
  if (existsSync(ADDON_DIR) && next === current) {
    let identical = true
    for (const [name, expected] of wanted) {
      try { if (!expected.equals(await readFile(path.join(ADDON_DIR, name)))) identical = false }
      catch { identical = false }
    }
    if (identical) return
  }
  const temporary = await mkdtemp(path.join(ADDON_ROOT, '.lawyercopilot-stage-'))
  const backup = `${ADDON_DIR}.backup-${randomBytes(6).toString('hex')}`
  let movedOld = false
  try {
    for (const [name, content] of wanted) {
      await writeFile(path.join(temporary, name), content, { mode: 0o600 })
    }
    await writeFile(path.join(temporary, '.lawyercopilot-addon'), 'lawyercopilot-wps-addon-v1\n', { mode: 0o600 })
    if (existsSync(ADDON_DIR)) { await rename(ADDON_DIR, backup); movedOld = true }
    await rename(temporary, ADDON_DIR)
    if (next !== current) await atomicWrite(PUBLISH, next)
    if (movedOld) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (movedOld) {
      await rm(ADDON_DIR, { recursive: true, force: true }).catch(() => {})
      await rename(backup, ADDON_DIR).catch(() => {})
    }
    throw error
  }
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) { reject(fail('REQUEST_TOO_LARGE', '本机请求超过大小上限')); req.destroy() }
    })
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(fail('INVALID_JSON', '请求内容无效')) } })
    req.on('error', reject)
  })
}
function send(res, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}

export function createBridgeServer(state, options = {}) {
  const connections = new Map()
  const queued = new Map()
  const uncertaintyFile = options.uncertaintyFile
  let uncertain = Boolean(uncertaintyFile && existsSync(uncertaintyFile))
  let uncertainReason = uncertain ? '上一次 WPS 写入未能确认' : null
  if (uncertain) {
    try { uncertainReason = JSON.parse(readFileSync(uncertaintyFile, 'utf8')).reason || uncertainReason }
    catch { /* A damaged marker still blocks writes. */ }
  }
  let activeWriteId = null
  async function markUncertain(reason) {
    uncertain = true
    uncertainReason = reason
    if (uncertaintyFile) await atomicWrite(uncertaintyFile, JSON.stringify({ reason, at: new Date().toISOString() }))
  }
  async function clearUncertain() {
    if (uncertaintyFile) await rm(uncertaintyFile, { force: true })
    uncertain = false
    uncertainReason = null
  }
  let preflights = 0
  let polls = 0
  let lastRejectedHost = null
  const server = http.createServer(async (req, res) => {
    try {
      const origin = req.headers.origin
      if (origin && origin !== 'null' && origin !== 'file://') { send(res, 403, { error: 'invalid origin' }); return }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        if (!origin || !['/next', '/result'].includes(req.url)) { send(res, 403, { error: 'invalid preflight' }); return }
        preflights += 1
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-lc-wps-host, x-lc-wps-instance, x-lc-wps-addon-version')
        res.setHeader('Access-Control-Max-Age', '300')
        send(res, 204)
        return
      }
      if (req.headers.authorization !== `Bearer ${state.token}`) { send(res, 401, { error: 'unauthorized' }); return }
      if (req.url === '/status' && req.method === 'GET') {
        const live = [...connections.entries()].filter(([, item]) => Date.now() - item.at < CONNECTION_TTL)
        const current = ([, item]) => !state.addonVersion || item.loadedVersion === state.addonVersion
        const connected = live.filter(current).map(([host]) => host)
        const staleAddons = live.filter(item => !current(item))
          .map(([host, item]) => ({ host, loadedVersion: item.loadedVersion }))
        send(res, 200, { connected, staleAddons, addonVersion: state.addonVersion, uncertain, uncertainReason, installed: true,
          connectionState: connected.length > 0 ? 'connected' : staleAddons.length > 0 ? 'outdated' : 'waiting',
          hint: connected.length > 0 ? '可直接使用已连接的 WPS 组件'
            : staleAddons.length > 0 ? 'WPS 仍加载旧版办公助手；请正常重开 WPS 一次后继续使用。'
              : '暂未看到已连接组件；可用 wps_open_document 自动打开本机文件。首次安装后若仍无法连接，再正常重开 WPS。',
          preflights, polls, lastRejectedHost })
        return
      }
      if (req.url === '/next' && req.method === 'GET') {
        polls += 1
        const host = req.headers['x-lc-wps-host']
        const instance = req.headers['x-lc-wps-instance']
        if (!HOSTS.has(host) || typeof instance !== 'string' || instance.length > 128) {
          lastRejectedHost = { host: String(host).slice(0, 80), instanceLength: typeof instance === 'string' ? instance.length : -1 }
          send(res, 400, { error: 'invalid host' }); return
        }
        const loadedVersion = typeof req.headers['x-lc-wps-addon-version'] === 'string'
          && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(req.headers['x-lc-wps-addon-version'])
          ? req.headers['x-lc-wps-addon-version'] : null
        const current = connections.get(host)
        if (state.addonVersion && loadedVersion !== state.addonVersion
            && current?.loadedVersion === state.addonVersion
            && Date.now() - current.at < CONNECTION_TTL) {
          send(res, 204); return
        }
        connections.set(host, { instance, loadedVersion, at: Date.now() })
        if (state.addonVersion && loadedVersion !== state.addonVersion) { send(res, 204); return }
        const item = [...queued.values()].find(entry => entry.host === host && !entry.dispatched)
        if (!item) { send(res, 204); return }
        item.dispatched = true
        item.instance = instance
        if (requiresConfirmation(item.action)) {
          try { await markUncertain('WPS 写入已发出，结果尚未确认') }
          catch {
            queued.delete(item.id)
            clearTimeout(item.timer)
            activeWriteId = null
            item.resolve({ ok: false, error: { code: 'STATE_UNAVAILABLE', message: '无法记录 WPS 写入状态，操作已停止' } })
            send(res, 500, { error: '无法记录 WPS 写入状态，操作已停止' })
            return
          }
        }
        send(res, 200, { id: item.id, host: item.host, action: item.action, params: item.params })
        return
      }
      if (req.url === '/result' && req.method === 'POST') {
        const body = await readJson(req)
        const item = queued.get(body?.id)
        if (!item || !item.dispatched || item.instance !== req.headers['x-lc-wps-instance'] || body.instance !== item.instance) {
          send(res, 409, { error: 'unknown result' }); return
        }
        if (requiresConfirmation(item.action)) {
          if (body.ok === true || body.payload?.code !== 'PARTIAL_WRITE') await clearUncertain()
          else await markUncertain('WPS 可能已部分修改，请先核查文档')
          activeWriteId = null
        }
        queued.delete(item.id)
        clearTimeout(item.timer)
        item.resolve(body.ok === true ? { ok: true, result: body.payload } : { ok: false, error: body.payload })
        send(res, 200, { accepted: true })
        return
      }
      if (req.url === '/acknowledge' && req.method === 'POST') {
        const body = await readJson(req)
        if (body?.checked !== true) { send(res, 400, { error: '需先在 WPS 核查文档' }); return }
        if (activeWriteId) { send(res, 409, { error: '仍有 WPS 写入操作正在处理' }); return }
        await clearUncertain()
        send(res, 200, { uncertain: false })
        return
      }
      if (req.url === '/command' && req.method === 'POST') {
        const body = await readJson(req)
        if (!HOSTS.has(body?.host) || typeof body.action !== 'string' || !/^[a-z_]{1,40}$/.test(body.action)
            || body.params === null || typeof body.params !== 'object' || Array.isArray(body.params)) {
          send(res, 400, { error: 'invalid command' }); return
        }
        if (body.action === 'export_pdf' && !validStagedOutputPath(body.params.output, state.exportRoot, 'pdf')) {
          send(res, 400, { error: 'invalid export destination' }); return
        }
        if (body.action === 'create_document' && (!CREATE_EXTENSION[body.host]
            || !validStagedOutputPath(body.params.output, state.exportRoot, CREATE_EXTENSION[body.host])
            || (body.params.bootstrapPath !== undefined
              && !validBootstrapStagedPath(body.params.bootstrapPath, state.exportRoot, CREATE_EXTENSION[body.host])))) {
          send(res, 400, { error: 'invalid export destination' }); return
        }
        if (body.action === 'insert_image' && (!['word', 'presentation'].includes(body.host)
            || !validStagedImagePath(body.params.imagePath, state.exportRoot))) {
          send(res, 400, { error: 'invalid image source' }); return
        }
        const connected = connections.get(body.host)
        if (!connected || Date.now() - connected.at > CONNECTION_TTL) { send(res, 409, { error: '对应的 WPS 组件尚未连接；请在 WPS 中打开该类文档，首次安装后需要重新打开 WPS' }); return }
        if (state.addonVersion && connected.loadedVersion !== state.addonVersion) {
          send(res, 409, { error: 'WPS 仍加载旧版办公助手；请正常重开 WPS 一次后继续使用' }); return
        }
        const writeAction = requiresConfirmation(body.action)
        if (uncertain && writeAction) { send(res, 409, { error: '上一次 WPS 写入结果未知，请先在 WPS 检查文档' }); return }
        if (writeAction && activeWriteId) { send(res, 409, { error: '上一项 WPS 写入仍在执行，请稍后再试' }); return }
        if (writeAction && body.confirm !== true) { send(res, 400, { error: '写入前需要律师确认' }); return }
        if (queued.size >= 16) { send(res, 429, { error: 'WPS 操作队列已满' }); return }
        const id = randomUUID()
        if (writeAction) activeWriteId = id
        const value = await new Promise(resolve => {
          const item = { id, host: body.host, action: body.action, params: body.params, dispatched: false, resolve }
          item.timer = setTimeout(() => {
            queued.delete(id)
            if (writeAction) activeWriteId = null
            if (item.dispatched && writeAction) {
              uncertain = true
              uncertainReason = 'WPS 写入已发出，但结果未知；请先核查文档'
            }
            resolve({ ok: false, error: { code: item.dispatched ? 'RESULT_UNKNOWN' : 'NOT_SENT', message: item.dispatched ? 'WPS 操作已发出，但没有收到确定结果；请在 WPS 核查后再操作' : 'WPS 没有接收此操作' } })
          }, ['export_pdf', 'create_document'].includes(item.action) ? 180_000 : 55_000)
          queued.set(id, item)
        })
        send(res, 200, value)
        return
      }
      send(res, 404, { error: 'not found' })
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: String(error?.message ?? error).slice(0, 300) })
    }
  })
  return server
}

function httpCall(state, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: state.port, path: route, method,
      headers: { Authorization: `Bearer ${state.token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { response += chunk; if (response.length > MAX_BODY) req.destroy(fail('RESPONSE_TOO_LARGE', 'WPS 响应过大')) })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(response) }) }
        catch { reject(fail('INVALID_RESPONSE', 'WPS 连接返回了无效结果')) }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(fail('BRIDGE_TIMEOUT', 'WPS 本机连接超时；写入结果可能未知，请先核查 WPS')))
    req.on('error', reject)
    req.end(payload)
  })
}

async function checkedHttpCall(state, method, route, body, timeoutMs) {
  try { return await httpCall(state, method, route, body, timeoutMs) }
  catch (cause) {
    const detail = existsSync(ERROR_FILE) ? (await readFile(ERROR_FILE, 'utf8')).slice(0, 400) : ''
    if (/EPERM|EACCES|operation not permitted|permission denied/i.test(detail)) {
      throw fail('WPS_ACCESS_DENIED', 'LawyerCopilot 尚无访问本机 WPS 加载项的系统权限。请在 macOS「隐私与安全 → 文件与文件夹 → LawyerCopilot.app」中打开「WPS Office」，再重开客户端。')
    }
    throw fail('BRIDGE_UNAVAILABLE', detail || String(cause?.message ?? cause).slice(0, 300))
  }
}

export async function waitForBridge(state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await httpCall(state, 'GET', '/status', undefined, 1500)
      if (response.status === 200) return response
      throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 本机连接拒绝了状态检查')
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'BRIDGE_TIMEOUT'].includes(error?.code)) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return checkedHttpCall(state, 'GET', '/status', undefined, 1500)
}

async function serve(assetDir) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  let state = await existingState()
  if (!state) state = { port: 40000 + Math.floor(Math.random() * 10000), token: randomBytes(32).toString('hex') }
  state.exportRoot = STAGE_ROOT
  state.addonVersion = await pluginVersion(assetDir)
  const server = createBridgeServer(state, { uncertaintyFile: UNCERTAINTY_FILE })
  const parentPid = process.ppid
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(state.port, '127.0.0.1', resolve) })
    await installAddon(assetDir, state)
    await atomicWrite(STATE_FILE, JSON.stringify(state))
    await rm(ERROR_FILE, { force: true })
    if (parentPid > 1) {
      const monitor = setInterval(() => {
        if (process.ppid === parentPid) return
        clearInterval(monitor)
        server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 2000).unref()
      }, 3000)
      monitor.unref()
      server.once('close', () => clearInterval(monitor))
    }
  } catch (error) {
    await writeFile(ERROR_FILE, String(error?.message ?? error).slice(0, 500), { mode: 0o600 }).catch(() => {})
    server.close()
    throw error
  }
}

export async function normalizeDocumentRequest(input) {
  const supplied = input?.params?.path
  if (supplied === undefined) return input
  if (typeof supplied !== 'string' || !path.isAbsolute(supplied) || supplied.includes('\0')) {
    throw fail('INVALID_PATH', 'WPS 文档路径必须是本机绝对路径')
  }
  let canonical
  try { canonical = await realpath(supplied) }
  catch { throw fail('DOCUMENT_NOT_FOUND', '指定的本机文档不存在或无法访问') }
  return { ...input, params: { ...input.params, path: canonical } }
}

export async function exportPdfWithBridge(state, input, options = {}) {
  const stageRoot = options.stageRoot ?? STAGE_ROOT
  const invoke = options.invoke ?? (command => checkedHttpCall(state, 'POST', '/command', command, 185_000))
  if (state.exportRoot !== stageRoot || !path.isAbsolute(stageRoot)) {
    throw fail('BRIDGE_STATE_INVALID', 'WPS PDF 暂存路径配置无效')
  }
  if (input.confirm !== true) throw fail('CONFIRM_REQUIRED', '导出 PDF 前需要律师明确要求或确认')
  if (!HOSTS.has(input.host) || typeof input?.params?.path !== 'string') throw fail('INVALID_REQUEST', '需要指定 WPS 组件和已打开的文档')
  if (typeof input.output !== 'string' || path.extname(input.output).toLowerCase() !== '.pdf'
      || input.output.endsWith(path.sep)) throw fail('INVALID_OUTPUT', 'PDF 输出必须是新的 .pdf 文件绝对路径')
  const source = await checkInput(input.params.path)
  if (DOCUMENT_HOST.get(path.extname(source).toLowerCase()) !== input.host) {
    throw fail('HOST_MISMATCH', '文件类型与所选 WPS 组件不匹配')
  }
  const output = await checkOutput(input.output, [source], 'export_pdf')
  let stage
  let delivered = false
  try {
    await mkdir(stageRoot, { recursive: true, mode: 0o700 })
    stage = await mkdtemp(path.join(stageRoot, 'job-'))
    const stagedOutput = path.join(stage, 'output.pdf')
    const response = await invoke({
      host: input.host, action: 'export_pdf', params: { path: source, output: stagedOutput }, confirm: true,
    })
    if (response.status !== 200) throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 拒绝了 PDF 导出')
    if (response.data?.ok !== true) throw fail(response.data?.error?.code ?? 'WPS_EXPORT_FAILED', response.data?.error?.message ?? 'WPS PDF 导出失败')
    if (!await verifyPdf(stagedOutput)) throw fail('OUTPUT_UNVERIFIED', 'WPS 返回成功，但 PDF 文件未通过结构检查；请先核查本机暂存结果')
    const files = await deliverOutput(stagedOutput, output)
    delivered = true
    return { exported: true, host: input.host, source, output: input.output, canonicalOutput: files[0] }
  } finally {
    if (stage && (delivered || !existsSync(path.join(stage, 'output.pdf')))) await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export async function insertImageWithBridge(state, input, options = {}) {
  const stageRoot = options.stageRoot ?? STAGE_ROOT
  const invoke = options.invoke ?? (command => checkedHttpCall(state, 'POST', '/command', command, 65_000))
  if (state.exportRoot !== stageRoot || !path.isAbsolute(stageRoot)) {
    throw fail('BRIDGE_STATE_INVALID', 'WPS 图片暂存路径配置无效')
  }
  if (input?.confirm !== true) throw fail('CONFIRM_REQUIRED', '插入图片前需要律师明确要求或确认')
  if (!['word', 'presentation'].includes(input.host) || typeof input?.params?.path !== 'string'
      || typeof input?.params?.image !== 'string') throw fail('INVALID_REQUEST', '需要指定 WPS 文档和图片')
  const placement = input.host === 'word'
    ? { expectedVersion: input.params.expectedVersion }
    : { slide: input.params.slide, expectedSlides: input.params.expectedSlides,
      expectedShapeCount: input.params.expectedShapeCount, left: input.params.left,
      top: input.params.top, width: input.params.width, height: input.params.height }
  if (input.host === 'word' && (typeof placement.expectedVersion !== 'string'
      || !/^[0-9]+:[a-f0-9]{16}$/.test(placement.expectedVersion))) {
    throw fail('INVALID_VERSION', '插图前需要先读取当前文字文档版本')
  }
  if (input.host === 'presentation' && (!Number.isInteger(placement.slide) || placement.slide < 1
      || !Number.isInteger(placement.expectedSlides) || placement.expectedSlides < placement.slide
      || placement.expectedSlides > 1000 || !Number.isInteger(placement.expectedShapeCount)
      || placement.expectedShapeCount < 0 || placement.expectedShapeCount > 1000
      || ![placement.left, placement.top, placement.width, placement.height].every(Number.isFinite)
      || placement.left < 0 || placement.top < 0 || placement.width <= 0 || placement.height <= 0
      || [placement.left, placement.top, placement.width, placement.height].some(value => value > 2000))) {
    throw fail('INVALID_PLACEMENT', '幻灯片图片位置、大小或刚读取的数量无效')
  }
  const document = await checkInput(input.params.path)
  if (DOCUMENT_HOST.get(path.extname(document).toLowerCase()) !== input.host) {
    throw fail('HOST_MISMATCH', '文档类型与插图目标组件不匹配')
  }
  const image = await checkInput(input.params.image)
  const extension = path.extname(image).toLowerCase()
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw fail('INVALID_IMAGE', '图片仅支持 PNG 或 JPG')
  const imageStat = await lstat(image)
  if (imageStat.size > 10 * 1024 * 1024) throw fail('INVALID_IMAGE', '图片不得超过 10 MB')
  const bytes = await readFile(image)
  const png = extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = ['.jpg', '.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (!png && !jpeg) throw fail('INVALID_IMAGE', '图片内容与 PNG/JPG 格式不匹配')
  const after = await lstat(image)
  if (after.dev !== imageStat.dev || after.ino !== imageStat.ino || after.size !== imageStat.size
      || after.mtimeMs !== imageStat.mtimeMs) throw fail('INPUT_CHANGED', '图片在读取时发生变化，已停止')
  await mkdir(stageRoot, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(path.join(stageRoot, 'job-'))
  const stagedImage = path.join(stage, `source${extension}`)
  let preserve = true
  try {
    await writeFile(stagedImage, bytes, { flag: 'wx', mode: 0o600 })
    const response = await invoke({ host: input.host, action: 'insert_image', params: {
      path: document, imagePath: stagedImage, ...placement,
    }, confirm: true })
    preserve = ['PARTIAL_WRITE', 'RESULT_UNKNOWN'].includes(response.data?.error?.code)
    if (response.status !== 200) throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 拒绝了图片插入')
    if (response.data?.ok !== true) {
      throw fail(response.data?.error?.code ?? 'WPS_IMAGE_FAILED', response.data?.error?.message ?? 'WPS 图片插入失败')
    }
    return response.data
  } finally {
    if (!preserve) await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export async function prepareCreateDocument(input) {
  if (input?.confirm !== true) throw fail('CONFIRM_REQUIRED', '新建文档前需要律师明确要求或确认')
  const extension = CREATE_EXTENSION[input.host]
  if (!extension) throw fail('HOST_MISMATCH', '需要指定文字、表格或演示组件')
  if (typeof input.output !== 'string' || path.extname(input.output).toLowerCase() !== `.${extension}`
      || input.output.endsWith(path.sep)) throw fail('INVALID_OUTPUT', `新文件必须使用 .${extension} 扩展名和绝对路径`)
  const content = input.host === 'word' ? { text: input.text } : input.host === 'spreadsheet' ? { cells: input.cells } : { slides: input.slides }
  if (input.host === 'word' && (typeof content.text !== 'string' || content.text.length > 12000)) {
    throw fail('INVALID_CONTENT', '文字内容无效或过长')
  }
  if (input.host === 'spreadsheet' && (!Array.isArray(content.cells) || content.cells.length > 500)) {
    throw fail('INVALID_CONTENT', '表格单元格数量无效')
  }
  if (input.host === 'spreadsheet') {
    const seen = new Set()
    for (const cell of content.cells) {
      const address = typeof cell?.address === 'string' ? cell.address : ''
      const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address)
      let column = 0
      if (match) for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
      if (!match || column > 16384 || Number(match[2]) > 1048576 || seen.has(address)
          || !['string', 'number', 'boolean'].includes(typeof cell.value)
          || (typeof cell.value === 'number' && !Number.isFinite(cell.value))
          || (typeof cell.value === 'string' && (cell.value.length > 2000 || /^[\s\u0000-\u001f]*[=+@-]/.test(cell.value)))) {
        throw fail('INVALID_CONTENT', '单元格无效、重复或包含不允许的公式')
      }
      seen.add(address)
    }
  }
  if (input.host === 'presentation' && (!Array.isArray(content.slides) || content.slides.length < 1 || content.slides.length > 20)) {
    throw fail('INVALID_CONTENT', '演示页数无效')
  }
  if (input.host === 'presentation' && content.slides.some(slide => !slide
      || typeof slide.title !== 'string' || slide.title.length > 200
      || typeof slide.subtitle !== 'string' || slide.subtitle.length > 2000)) {
    throw fail('INVALID_CONTENT', '演示标题或正文无效')
  }
  const output = await checkOutput(input.output, [], 'create_document')
  return { extension, content, output }
}

export async function createDocumentWithBridge(state, input, options = {}) {
  const stageRoot = options.stageRoot ?? STAGE_ROOT
  const invoke = options.invoke ?? (command => checkedHttpCall(state, 'POST', '/command', command, 185_000))
  if (state.exportRoot !== stageRoot || !path.isAbsolute(stageRoot)) {
    throw fail('BRIDGE_STATE_INVALID', 'WPS 文档暂存路径配置无效')
  }
  const { extension, content, output } = await prepareCreateDocument(input)
  if (input.bootstrapPath !== undefined && !validBootstrapStagedPath(input.bootstrapPath, stageRoot, extension)) {
    throw fail('INVALID_PATH', 'WPS 组件启动文件路径无效')
  }
  let stage
  let delivered = false
  try {
    await mkdir(stageRoot, { recursive: true, mode: 0o700 })
    stage = await mkdtemp(path.join(stageRoot, 'job-'))
    const stagedOutput = path.join(stage, `output.${extension}`)
    const response = await invoke({ host: input.host, action: 'create_document',
      params: { ...content, output: stagedOutput, ...(input.bootstrapPath ? { bootstrapPath: input.bootstrapPath } : {}) }, confirm: true })
    if (response.status !== 200) throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 拒绝了新建文档')
    if (response.data?.ok !== true) throw fail(response.data?.error?.code ?? 'WPS_CREATE_FAILED', response.data?.error?.message ?? 'WPS 新建文档失败')
    if (!await verifyOfficePackage(stagedOutput, input.host)) {
      throw fail('OUTPUT_UNVERIFIED', 'WPS 返回成功，但新文档未通过结构检查；请先核查本机暂存结果')
    }
    const files = await deliverOutput(stagedOutput, output)
    delivered = true
    return { created: true, host: input.host, output: input.output, canonicalOutput: files[0],
      bootstrapClosed: response.data?.result?.bootstrapClosed ?? !input.bootstrapPath }
  } finally {
    if (stage && (delivered || !existsSync(path.join(stage, `output.${extension}`)))) await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export async function bootstrapHost(state, host, options = {}) {
  const stageRoot = options.stageRoot ?? STAGE_ROOT
  const assetsDir = options.assetsDir ?? fileURLToPath(new URL('.', import.meta.url))
  const extension = CREATE_EXTENSION[host]
  if (!extension || state.exportRoot !== stageRoot || !path.isAbsolute(stageRoot)) {
    throw fail('BRIDGE_STATE_INVALID', 'WPS 组件启动配置无效')
  }
  const template = path.join(assetsDir, `bootstrap.${extension}`)
  if (!await verifyOfficePackage(template, host)) throw fail('BOOTSTRAP_INVALID', 'WPS 组件启动文件无效')
  await mkdir(stageRoot, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(path.join(stageRoot, 'boot-'))
  const copied = path.join(stage, `bootstrap.${extension}`)
  await copyFile(template, copied)
  const documentPath = await realpath(copied)
  const openFile = options.openFile ?? (async file => exec('/usr/bin/open', wpsOpenArgs(file, await resolveWpsApp()),
    { timeout: 10_000, maxBuffer: 64 * 1024 }))
  const observe = options.observe ?? (async file => {
    const response = await httpCall(state, 'POST', '/command', { host, action: 'list', params: {} }, 5000)
    return response.status === 200 && response.data?.ok === true
      && response.data.result?.documents?.some(item => item.path === file)
  })
  try { await openFile(documentPath) }
  catch (error) { throw fail('WPS_OPEN_FAILED', `WPS 未能启动${host}组件：${String(error?.message ?? error).slice(0, 200)}`) }
  const deadline = Date.now() + HOST_START_WAIT_MS
  while (Date.now() < deadline) {
    try { if (await observe(documentPath)) return { path: documentPath, stage } }
    catch { /* The WPS component may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw fail('WPS_BOOTSTRAP_UNVERIFIED', '已请求 WPS 打开本机空白文件，但对应组件尚未连接；请检查首次加载提示')
}

async function requestBridge(input) {
  let state = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await existingState()
    if (state) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (!state) {
    const cause = existsSync(ERROR_FILE) ? (await readFile(ERROR_FILE, 'utf8')).slice(0, 400) : '本机连接尚未启动'
    throw fail('BRIDGE_UNAVAILABLE', cause)
  }
  const ready = await waitForBridge(state)
  const expectedVersion = await pluginVersion(fileURLToPath(new URL('.', import.meta.url)))
  if (ready.data?.addonVersion !== expectedVersion) {
    throw fail('BRIDGE_VERSION_MISMATCH', 'LawyerCopilot 的 WPS 本机连接仍为旧版；请正常重开客户端一次后继续使用')
  }
  const requestedHost = input?.action === 'open_document' && typeof input?.params?.path === 'string'
    ? DOCUMENT_HOST.get(path.extname(input.params.path).toLowerCase()) : input?.host
  if (requestedHost && ready.data?.staleAddons?.some(item => item.host === requestedHost)) {
    throw fail('ADDON_VERSION_MISMATCH', 'WPS 仍加载旧版办公助手；请正常重开 WPS 一次后继续使用')
  }
  if (input?.action === 'export_pdf') return exportPdfWithBridge(state, input)
  if (input?.action === 'insert_image') return insertImageWithBridge(state, input)
  if (input?.action === 'create_document') {
    await prepareCreateDocument(input)
    const connected = Array.isArray(ready.data?.connected) && ready.data.connected.includes(input.host)
    if (connected) return createDocumentWithBridge(state, input)
    const bootstrap = await bootstrapHost(state, input.host)
    const result = await createDocumentWithBridge(state, { ...input, bootstrapPath: bootstrap.path })
    if (result.bootstrapClosed) await rm(bootstrap.stage, { recursive: true, force: true })
    else result.warning = 'WPS 启动文件仍在打开，请在 WPS 中核查该临时文件'
    return result
  }
  if (input?.action === 'acknowledge') {
    const response = await checkedHttpCall(state, 'POST', '/acknowledge', { checked: input.checked }, 5000)
    if (response.status !== 200) throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 核查确认未被接受')
    return response.data
  }
  if (input?.action === 'open_document') {
    const candidate = input?.params?.path
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.length > 4096 || candidate.includes('\0')) {
      throw fail('INVALID_PATH', '文档必须使用本机绝对路径')
    }
    const host = DOCUMENT_HOST.get(path.extname(candidate).toLowerCase())
    if (!host) throw fail('UNSUPPORTED_DOCUMENT', '目前只能打开 Word、Excel 或 PowerPoint 文件')
    const documentPath = await realpath(candidate)
    const stat = await lstat(documentPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 64 * 1024 * 1024) {
      throw fail('INVALID_DOCUMENT', '只能打开 64 MB 以内的普通文档文件')
    }
    try {
      await exec('/usr/bin/open', wpsOpenArgs(documentPath, await resolveWpsApp()), { timeout: 10_000, maxBuffer: 64 * 1024 })
    } catch (error) {
      throw fail('WPS_OPEN_FAILED', `WPS 未能打开文档：${String(error?.message ?? error).slice(0, 200)}`)
    }
    const until = Date.now() + HOST_START_WAIT_MS
    while (Date.now() < until) {
      try {
        const observed = await httpCall(state, 'POST', '/command', { host, action: 'list', params: {} }, 5000)
        if (observed.status === 200 && observed.data?.ok === true
            && observed.data.result?.documents?.some(item => item.path === documentPath)) {
          return { opened: true, host, path: documentPath }
        }
      } catch { /* WPS may still be opening the document. */ }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    throw fail('WPS_OPEN_UNVERIFIED', '已请求 WPS 打开文件，但尚未在 WPS 中读回确认；请检查窗口或首次加载提示')
  }
  const isStatus = input?.action === 'status'
  if (isStatus) return ready.data
  const response = await checkedHttpCall(state, 'POST', '/command', await normalizeDocumentRequest(input), 60_000)
  if (response.status !== 200) throw fail('BRIDGE_REJECTED', response.data?.error ?? 'WPS 拒绝了本次操作')
  return response.data
}

async function main() {
  if (process.argv[2] === '--serve') { await serve(process.argv[3]); return }
  if (process.argv[2] === '--request') {
    let text = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) { text += chunk; if (text.length > MAX_BODY) throw fail('REQUEST_TOO_LARGE', '请求过大') }
    const result = await requestBridge(JSON.parse(text))
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
    return
  }
  throw fail('INVALID_ARGUMENT', '不支持的连接操作')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: { code: error?.code ?? 'WPS_BRIDGE_ERROR', message: String(error?.message ?? error).slice(0, 600) } }) + '\n') })
}
