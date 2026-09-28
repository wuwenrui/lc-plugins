import { execFile } from 'node:child_process'
import { createReadStream, existsSync, constants as fsConstants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const WPS_BUNDLE_ID = 'com.kingsoft.wpsoffice.mac'
const DEFAULT_WPS_BUNDLES = [
  '/Applications/wpsoffice.app', '/Applications/WPS Office.app',
  path.join(homedir(), 'Applications/wpsoffice.app'), path.join(homedir(), 'Applications/WPS Office.app'),
]
let cachedWpsCli = null

async function spotlightWpsBundles() {
  try {
    const { stdout } = await exec('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${WPS_BUNDLE_ID}"`],
      { timeout: 3000, maxBuffer: 64 * 1024 })
    return stdout.split(/\r?\n/).filter(Boolean).slice(0, 50)
  } catch { return [] }
}

async function wpsBundleId(bundle) {
  const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')],
    { timeout: 3000, maxBuffer: 1024 })
  return stdout.trim()
}

export async function resolveWpsApp(options = {}) {
  const bundlePaths = options.bundlePaths ?? DEFAULT_WPS_BUNDLES
  const discoverBundles = options.discoverBundles ?? spotlightWpsBundles
  const readBundleId = options.readBundleId ?? wpsBundleId
  const seen = new Set()
  async function matchingBundle(bundle) {
    if (seen.has(bundle)) return false
    seen.add(bundle)
    if (typeof bundle !== 'string' || !path.isAbsolute(bundle) || !bundle.endsWith('.app')) return false
    const candidate = path.join(bundle, 'Contents/MacOS/wpscli')
    try {
      const stat = await lstat(candidate)
      return Boolean(stat.isFile() && (stat.mode & 0o111) && await readBundleId(bundle) === WPS_BUNDLE_ID)
    } catch { /* Continue to another registered WPS bundle. */ }
    return false
  }
  for (const bundle of bundlePaths) {
    if (await matchingBundle(bundle)) return bundle
  }
  for (const bundle of await discoverBundles()) {
    if (await matchingBundle(bundle)) return bundle
  }
  throw new WpsError('WPS_MISSING', '没有找到本机 WPS Office')
}

export async function resolveWpsCli(options = {}) {
  return path.join(await resolveWpsApp(options), 'Contents/MacOS/wpscli')
}

async function installedWpsCli() {
  if (!cachedWpsCli) cachedWpsCli = resolveWpsCli().catch(error => { cachedWpsCli = null; throw error })
  return cachedWpsCli
}
export const STAGE_ROOT = path.join(homedir(), 'Library/Containers/com.kingsoft.wpsoffice.mac/Data/Library/Caches/LawyerCopilot-WpsStage')
const RUN_STATE_ROOT = path.join(homedir(), '.ccgui-next', 'wps-runner')
const LOCK_DIR = path.join(RUN_STATE_ROOT, '.wpscli-lock')
const COMMANDS = Object.freeze([
  'pdf2word', 'pdf2excel', 'pdf2ppt', 'pdf2md', 'pdf2txt', 'pdf2imgpdf',
  'pdf2cad', 'pdf2photo', 'photo2pdf', 'cad2pdf', 'pdfsplit', 'pdfmerge',
  'pdfcompress', 'pdfwatermark', 'pdfremovewatermark', 'pdfencrypt', 'pdfinfo',
])
const COMMAND_SET = new Set(COMMANDS)
const MAX_REPLY = 48_000

export class WpsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function absoluteFile(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || !path.isAbsolute(value) || value.includes('\0')) {
    throw new WpsError('INVALID_ARGUMENT', `${label}必须是本机绝对路径`)
  }
  return path.resolve(value)
}

export async function checkInput(value) {
  const target = absoluteFile(value, '输入文件')
  let stat
  try { stat = await lstat(target) } catch { throw new WpsError('INPUT_NOT_FOUND', '输入文件不存在或不可访问') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 200 * 1024 * 1024) {
    throw new WpsError('INPUT_INVALID', '输入必须是非空普通文件，且不超过 200 MB')
  }
  return realpath(target)
}

export async function checkOutput(value, inputs, command) {
  const target = absoluteFile(value, '输出位置')
  const parent = command === 'pdfsplit' || command === 'pdf2photo' || value.endsWith(path.sep)
    ? target : path.dirname(target)
  let stat
  try { stat = await lstat(parent) } catch { throw new WpsError('OUTPUT_PARENT_MISSING', '输出目录不存在') }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new WpsError('OUTPUT_PARENT_INVALID', '输出位置必须是目录')
  const canonicalParent = await realpath(parent)
  if (!(await lstat(canonicalParent)).isDirectory()) throw new WpsError('OUTPUT_PARENT_INVALID', '输出位置必须是目录')
  const canonicalTarget = parent === target ? canonicalParent : path.join(canonicalParent, path.basename(target))
  if (inputs.includes(canonicalTarget)) throw new WpsError('OUTPUT_IS_INPUT', '输出位置不能覆盖原件')
  if (existsSync(canonicalTarget) && parent !== target) throw new WpsError('OUTPUT_EXISTS', '输出文件已存在，请换一个名称')
  return { target: canonicalTarget, directory: parent === target }
}

async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function stageInputs(inputs, stage) {
  const names = inputs.map(file => path.basename(file))
  if (new Set(names).size !== names.length) {
    throw new WpsError('INPUT_NAME_CONFLICT', '批量文件存在同名文件，请分批处理')
  }
  const staged = []
  for (let index = 0; index < inputs.length; index += 1) {
    const source = inputs[index]
    const target = path.join(stage, names[index])
    const before = await lstat(source)
    await copyFile(source, target, fsConstants.COPYFILE_EXCL)
    const after = await lstat(source)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || await hashFile(source) !== await hashFile(target)) {
      throw new WpsError('INPUT_CHANGED', '输入文件在交给 WPS 前发生变化，已停止处理')
    }
    staged.push(target)
  }
  return staged
}

async function outputFiles(root, relative = '', depth = 0) {
  if (depth > 3) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物目录层级异常')
  const paths = []
  for (const name of await readdir(path.join(root, relative))) {
    if (!name || name === '.' || name === '..') throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物名称无效')
    const child = path.join(relative, name)
    const stat = await lstat(path.join(root, child))
    if (stat.isSymbolicLink()) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物包含链接')
    if (stat.isDirectory()) paths.push(...await outputFiles(root, child, depth + 1))
    else if (stat.isFile()) paths.push(child)
    else throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物类型异常')
    if (paths.length > 100) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物数量超过上限')
  }
  return paths
}

export async function deliverOutput(stagedOutput, output) {
  const sourceNames = output.directory ? await outputFiles(stagedOutput) : [path.basename(stagedOutput)]
  if (sourceNames.length === 0 || sourceNames.length > 100) {
    throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 返回成功，但产物数量异常；请核查本机缓存')
  }
  const delivered = []
  try {
    for (const name of sourceNames) {
      const source = output.directory ? path.join(stagedOutput, name) : stagedOutput
      const destination = output.directory ? path.join(output.target, name) : output.target
      const stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 200 * 1024 * 1024) {
        throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 产物不是有效的普通文件')
      }
      if (existsSync(destination)) throw new WpsError('OUTPUT_EXISTS', `目标文件已存在：${name}`)
      if (output.directory) await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
      delivered.push(destination)
      if (await hashFile(source) !== await hashFile(destination)) {
        throw new WpsError('OUTPUT_UNVERIFIED', '交付文件内容核验失败')
      }
    }
    return delivered
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WpsError('DELIVERY_FAILED', `WPS 产物交付失败：${message}；已交付 ${delivered.join('、') || '无'}，请检查后再处理`)
  }
}

export function presentDeliveredPaths(requested, canonicalOutput, delivered, directory) {
  return { output: requested, canonicalOutput,
    files: delivered.map(file => directory ? path.join(requested, path.relative(canonicalOutput, file)) : requested) }
}

async function cli(args, timeoutMs = 30_000) {
  const executable = await installedWpsCli()
  try {
    const result = await exec(executable, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new WpsError('WPS_MISSING', '没有找到本机 WPS Office')
    if (error?.killed || error?.signal) throw new WpsError('RESULT_UNKNOWN', 'WPS 操作超时，结果可能已写入；请先检查输出位置，不要立即重试')
    return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}

function assertCommand(value) {
  if (typeof value !== 'string' || !COMMAND_SET.has(value)) throw new WpsError('UNSUPPORTED_COMMAND', '此 WPS 命令不在已核对的本机能力列表中')
  return value
}

export function usableCommandHelp(command, result) {
  const help = String(result?.stdout ?? '')
  if (result?.code === 0) return help.slice(0, MAX_REPLY)
  const declared = /^NAME\r?\n[ \t]+([a-z][a-z0-9]*)\b/m.exec(help)?.[1]
  if (result?.code === 139 && declared === command
      && /^OPTIONS\s*$/m.test(help) && /^EXIT CODES\s*$/m.test(help)
      && /--json\b/.test(help)) return help.slice(0, MAX_REPLY)
  throw new WpsError('WPS_HELP_FAILED', '无法读取完整且匹配的本机 WPS 命令帮助')
}

async function commandHelp(command) {
  return usableCommandHelp(command, await cli([command, '--help']))
}

export function optionNames(help) {
  const section = help.split(/^OPTIONS\s*$/m)[1]?.split(/^\S[^\n]*\n/m)[0] ?? ''
  return new Set(Array.from(section.matchAll(/^\s+(?:-[a-z],\s*)?--([a-z][a-z0-9-]*)\b/gm), match => match[1]))
}

function optionArgs(options, allowed) {
  if (!ownObject(options)) throw new WpsError('INVALID_OPTIONS', '选项必须是键值对象')
  const args = []
  for (const [name, value] of Object.entries(options)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !allowed.has(name) || ['output', 'json', 'help', 'timeout'].includes(name)) {
      throw new WpsError('INVALID_OPTION', `不支持选项 ${name}`)
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new WpsError('INVALID_OPTION', `选项 ${name} 的值必须是文字、数字或布尔值`)
    }
    const text = String(value)
    if (!text || text.length > 2048 || text.includes('\0') || text.startsWith('--')) {
      throw new WpsError('INVALID_OPTION', `选项 ${name} 的值无效`)
    }
    args.push(`--${name}`, text)
  }
  return args
}

function readableCliError(result) {
  if (result.code === 100) return 'WPS 尚未登录，请先在 WPS 内登录会员账号'
  if (result.code === 101) return '当前 WPS 账号无此项会员权益'
  if (result.code === 209) return '源 PDF 需要打开密码'
  if (result.code === 210) return '源 PDF 密码不正确'
  const detail = (result.stderr || result.stdout).trim().slice(0, 1000)
  return `WPS 命令失败（退出码 ${result.code}）${detail ? `：${detail}` : ''}`
}

export function completedOutput(stdout) {
  let completed = null
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event?.type === 'completed') completed = event
    } catch { /* Human progress lines are allowed. */ }
  }
  return completed?.status === 'success' && typeof completed.output === 'string' ? completed.output : null
}

export async function acceptCompletedPhotoPdfCrash(outcome, expectedOutput) {
  return outcome?.code === 139 && typeof expectedOutput === 'string'
    && completedOutput(outcome.stdout) === expectedOutput
    && await verifyPdf(expectedOutput)
}

export function completedPdfInfo(stdout, expectedFile) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event?.type === 'completed' && event.file === expectedFile
          && Number.isInteger(event.page_count) && event.page_count >= 1 && event.page_count <= 10_000
          && typeof event.is_scan_document === 'boolean') {
        return { pageCount: event.page_count, isScanDocument: event.is_scan_document }
      }
    } catch { /* WPS may include plain progress lines. */ }
  }
  return null
}

export function parsePdfInfoPages(summary) {
  for (const line of String(summary ?? '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event?.type === 'completed' && Number.isInteger(event.page_count)
          && event.page_count >= 1 && event.page_count <= 10_000) return event.page_count
    } catch { /* Ignore WPS progress text. */ }
  }
  throw new WpsError('PDF_INFO_INVALID', '无法确定扫描件页数，已停止 OCR')
}

export async function verifyPptx(file) {
  try {
    await exec('/usr/bin/unzip', ['-t', file], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    const names = (await exec('/usr/bin/unzip', ['-Z', '-1', file], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.split(/\r?\n/)
    return names.includes('[Content_Types].xml') && names.includes('ppt/presentation.xml')
  } catch { return false }
}

export async function verifyOfficePackage(file, host) {
  const required = {
    word: 'word/document.xml', spreadsheet: 'xl/workbook.xml', presentation: 'ppt/presentation.xml',
  }[host]
  if (!required) return false
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 200 * 1024 * 1024) return false
    await exec('/usr/bin/unzip', ['-t', file], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    const names = (await exec('/usr/bin/unzip', ['-Z', '-1', file], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.split(/\r?\n/)
    return names.includes('[Content_Types].xml') && names.includes(required)
  } catch { return false }
}

export async function verifyPdf(file) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > 200 * 1024 * 1024) return false
    const handle = await open(file, 'r')
    const head = Buffer.alloc(8)
    const tail = Buffer.alloc(Math.min(1024, stat.size))
    try {
      await handle.read(head, 0, head.length, 0)
      await handle.read(tail, 0, tail.length, stat.size - tail.length)
    } finally { await handle.close() }
    return head.toString().startsWith('%PDF-') && tail.toString().includes('%%EOF')
  } catch { return false }
}

async function normalizePhotoPdf(stagedOutput, directory) {
  const names = directory ? await outputFiles(stagedOutput) : [path.basename(stagedOutput)]
  if (names.length === 0) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 没有生成图片 PDF')
  for (const name of names) {
    const source = directory ? path.join(stagedOutput, name) : stagedOutput
    if (path.extname(source).toLowerCase() !== '.pdf') throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 图片转换产物不是 PDF')
    const normalized = `${source}.normalized.pdf`
    const outcome = await cli(['pdfcompress', source, '--output', normalized, '--press-quality', 'best', '--json'], 300_000)
    if (outcome.code !== 0 || !existsSync(normalized)) {
      throw new WpsError('PDF_NORMALIZATION_FAILED', 'WPS 已生成图片 PDF，但兼容性规范化失败；暂存结果留在本机供核查')
    }
    const stat = await lstat(normalized)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > 200 * 1024 * 1024) {
      throw new WpsError('PDF_NORMALIZATION_FAILED', '规范化的 PDF 结构无效；暂存结果留在本机供核查')
    }
    const handle = await open(normalized, 'r')
    const head = Buffer.alloc(8)
    const tail = Buffer.alloc(64)
    try {
      await handle.read(head, 0, head.length, 0)
      await handle.read(tail, 0, tail.length, stat.size - tail.length)
    } finally { await handle.close() }
    if (!head.toString().startsWith('%PDF-') || !tail.toString().includes('%%EOF')) {
      throw new WpsError('PDF_NORMALIZATION_FAILED', '规范化的 PDF 结构无效；暂存结果留在本机供核查')
    }
    const previous = `${source}.before-normalization`
    await rename(source, previous)
    try { await rename(normalized, source); await rm(previous, { force: true }) }
    catch (error) { await rename(previous, source).catch(() => {}); throw error }
  }
}

async function withCliLock(work) {
  await mkdir(RUN_STATE_ROOT, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      await mkdir(LOCK_DIR, { mode: 0o700 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const ownerPath = path.join(LOCK_DIR, 'owner.json')
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
        if (Date.now() - owner.startedAt > 6 * 60_000 && Number.isInteger(owner.pid)) {
          let alive = true
          try { process.kill(owner.pid, 0) } catch (cause) { alive = cause?.code !== 'ESRCH' }
          if (!alive) await rm(LOCK_DIR, { recursive: true, force: true })
        }
      } catch { /* The owner may still be writing its marker. */ }
      if (Date.now() > deadline) throw new WpsError('WPS_BUSY', '本机 WPS 正在处理另一项任务，请稍后再试')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  try {
    await writeFile(path.join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 })
    return await work()
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true })
  }
}

async function runRequestUnlocked(request) {
  if (!ownObject(request)) throw new WpsError('INVALID_REQUEST', '请求格式无效')
  await installedWpsCli()
  if (request.action === 'status') {
    const version = await cli(['--version'], 10_000)
    return { installed: true, version: version.stdout.trim().slice(0, 200), commands: COMMANDS }
  }
  const command = assertCommand(request.command)
  if (request.action === 'help') return { command, help: await commandHelp(command) }
  if (request.action !== 'run' && request.action !== 'info') throw new WpsError('INVALID_ACTION', '不支持的操作')
  const rawInputs = request.action === 'info' ? [request.input] : request.inputs
  if (!Array.isArray(rawInputs) || rawInputs.length < 1 || rawInputs.length > 20) {
    throw new WpsError('INVALID_INPUTS', '每次需要 1 至 20 个输入文件')
  }
  if (request.action === 'info' && command !== 'pdfinfo') throw new WpsError('INVALID_ACTION', '只读信息工具只支持 pdfinfo')
  if (request.action === 'run' && (command === 'pdfinfo' || request.confirm !== true)) {
    throw new WpsError('CONFIRM_REQUIRED', '写出文件前，需要律师明确同意本次操作')
  }
  const inputs = await Promise.all(rawInputs.map(checkInput))
  let output = null
  if (request.action === 'run') {
    if (inputs.length > 1 && typeof request.output === 'string' && !request.output.endsWith(path.sep)
        && !['pdfsplit', 'pdf2photo', 'pdfmerge', 'photo2pdf'].includes(command)) {
      throw new WpsError('OUTPUT_DIRECTORY_REQUIRED', '批量处理的输出位置必须是目录，并以路径分隔符结尾')
    }
    output = await checkOutput(request.output, inputs, command)
  }
  const help = await commandHelp(command)
  const allowed = optionNames(help)
  const flags = optionArgs(request.options ?? {}, allowed)
  let stage
  try {
    await mkdir(STAGE_ROOT, { recursive: true, mode: 0o700 })
    stage = await mkdtemp(path.join(STAGE_ROOT, 'job-'))
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      throw new WpsError('WPS_ACCESS_DENIED', 'LawyerCopilot 尚无访问本机 WPS 文件空间的系统权限。请在 macOS「隐私与安全 → 文件与文件夹 → LawyerCopilot.app」中打开「WPS Office」，再重开客户端。')
    }
    throw error
  }
  let preserve = false
  try {
    const stagedInputs = await stageInputs(inputs, stage)
    const stagedOutput = output?.directory ? path.join(stage, 'output')
      : output ? path.join(stage, `output${path.extname(output.target)}`) : null
    if (output?.directory) await mkdir(stagedOutput, { mode: 0o700 })
    const args = [...stagedInputs]
    if (stagedOutput) args.push('--output', stagedOutput)
    args.push(...flags, '--json')
    let outcome
    try {
      outcome = await cli([command, ...args], 300_000)
    } catch (error) {
      if (error?.code === 'RESULT_UNKNOWN') {
        preserve = true
        error.recoveryPath = stage
      }
      throw error
    }
    let warning = null
    if (outcome.code !== 0) {
      if (command === 'pdfinfo' && outcome.code === 139 && completedPdfInfo(outcome.stdout, stagedInputs[0])) {
        warning = 'WPS 已完整报告该 PDF 信息，但命令进程退出异常（139）；本次仅采信匹配输入文件的完成事件。'
      } else if (command === 'photo2pdf' && await acceptCompletedPhotoPdfCrash(outcome, stagedOutput)) {
        warning = 'WPS 已报告图片转 PDF 完成且产物结构校验通过，但命令进程退出异常（139）。'
      } else {
        const recoveryCandidate = command === 'pdf2ppt' && outcome.code === 139 && stagedOutput
          && completedOutput(outcome.stdout) === stagedOutput
        if (!recoveryCandidate || !await verifyPptx(stagedOutput)) {
          if (recoveryCandidate) preserve = true
          throw new WpsError('WPS_COMMAND_FAILED', readableCliError(outcome))
        }
        warning = 'WPS 已报告转换成功且 PPTX 文件结构校验通过，但进程退出异常（139）；请打开演示文稿核对内容和版式。'
      }
    }
    if (command === 'pdf2ppt' && !await verifyPptx(stagedOutput)) {
      preserve = true
      throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 生成的 PPTX 结构校验失败；已保留本机暂存结果供核查')
    }
    if (command === 'photo2pdf') {
      try { await normalizePhotoPdf(stagedOutput, output.directory) }
      catch (error) { preserve = true; throw error }
    }
    let delivered
    try { delivered = output ? await deliverOutput(stagedOutput, output) : [] }
    catch (error) { preserve = true; throw error }
    let summary = outcome.stdout.trim()
    for (let index = 0; index < inputs.length; index += 1) {
      summary = summary.replaceAll(stagedInputs[index], inputs[index])
    }
    if (stagedOutput) summary = summary.replaceAll(stagedOutput, request.output)
    const visibleOutput = output ? presentDeliveredPaths(request.output, output.target, delivered, output.directory)
      : { output: null, files: [] }
    return { command, ...visibleOutput, result: summary.slice(0, MAX_REPLY), verified: Boolean(output),
      ...(command === 'photo2pdf' ? { normalized: true } : {}), ...(warning ? { warning } : {}) }
  } catch (error) {
    if (preserve && error instanceof Error) error.recoveryPath = stage
    throw error
  } finally {
    if (!preserve) await rm(stage, { recursive: true, force: true })
  }
}

export async function runOcrRequest(request, options = {}) {
  if (request?.confirm !== true) throw new WpsError('CONFIRM_REQUIRED', '在线 OCR 前需用户明确同意本次合成或指定文件的处理')
  if (request.aiFix !== undefined && typeof request.aiFix !== 'boolean') throw new WpsError('INVALID_OPTION', 'AI 修复选项无效')
  const input = await checkInput(request.input)
  const extension = path.extname(input).toLowerCase()
  if (!['.pdf', '.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new WpsError('INVALID_INPUT', 'OCR 输入须为本机 PDF、PNG 或 JPG 图片')
  }
  if (typeof request.output !== 'string' || path.extname(request.output).toLowerCase() !== '.docx'
      || request.output.endsWith(path.sep)) throw new WpsError('INVALID_OUTPUT', 'OCR 输出须为新的 .docx 文件绝对路径')
  await checkOutput(request.output, [input], 'ocr')
  const invoke = options.invoke ?? runRequest
  const scratchRoot = options.scratchRoot ?? path.join(RUN_STATE_ROOT, 'ocr')
  let scratch = null
  let preserve = false
  try {
    let pdf = input
    if (extension !== '.pdf') {
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
      scratch = await mkdtemp(path.join(scratchRoot, 'job-'))
      const intermediate = path.join(scratch, 'source.pdf')
      const converted = await invoke({ action: 'run', command: 'photo2pdf', inputs: [input], output: intermediate,
        options: {}, confirm: true })
      if (converted?.verified !== true) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 图片转 PDF 结果未获确认，已停止 OCR')
      pdf = converted.canonicalOutput ?? converted.output
      await checkInput(pdf)
    }
    const info = await invoke({ action: 'info', command: 'pdfinfo', input: pdf, options: {} })
    const pages = parsePdfInfoPages(info?.result)
    const recognized = await invoke({ action: 'run', command: 'pdf2word', inputs: [pdf], output: request.output,
      options: { scanned: true, range: pages === 1 ? '1' : `1-${pages}`,
        ...(request.aiFix === true ? { 'ai-fix': true } : {}) }, confirm: true })
    if (recognized?.verified !== true) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS OCR Word 结果未获确认')
    return { command: 'ocr', input: request.input, output: request.output,
      canonicalOutput: recognized.canonicalOutput ?? recognized.output, files: [request.output],
      pages, online: true, verified: true }
  } catch (error) {
    preserve = Boolean(scratch && existsSync(path.join(scratch, 'source.pdf')))
    throw error
  } finally {
    if (scratch && !preserve) await rm(scratch, { recursive: true, force: true })
  }
}

async function readTextWindow(file, offset, limit) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalCharacters = 0
  let text = ''
  let hasContent = false
  const append = part => {
    if (/\S/u.test(part)) hasContent = true
    const start = Math.max(0, offset - totalCharacters)
    const end = Math.min(part.length, offset + limit - totalCharacters)
    if (end > start) text += part.slice(start, end)
    totalCharacters += part.length
  }
  try {
    for await (const chunk of createReadStream(file)) append(decoder.decode(chunk, { stream: true }))
    append(decoder.decode())
  } catch (error) {
    if (error instanceof TypeError) throw new WpsError('PDF_TEXT_INVALID', 'WPS 提取的 PDF 文字不是有效 UTF-8')
    throw error
  }
  return { text, totalCharacters, hasContent, more: offset + limit < totalCharacters }
}

export async function readPdfRequest(request, options = {}) {
  const input = await checkInput(request?.input)
  if (path.extname(input).toLowerCase() !== '.pdf') throw new WpsError('INVALID_INPUT', '只能读取本机 PDF 文件')
  if (request.forceOcr !== undefined && typeof request.forceOcr !== 'boolean') {
    throw new WpsError('INVALID_OPTION', 'OCR 模式参数无效')
  }
  const offset = request.offset ?? 0
  const limit = request.limit ?? 12000
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000) {
    throw new WpsError('INVALID_RANGE', 'PDF 读取范围无效')
  }
  const invoke = options.invoke ?? runRequest
  const info = await invoke({ action: 'info', command: 'pdfinfo', input, options: {} })
  const details = completedPdfInfo(info?.result, input)
  if (!details) throw new WpsError('PDF_INFO_INVALID', 'WPS 没有返回完整的 PDF 页面信息')
  const needsOcr = details.isScanDocument || request.forceOcr === true
  if (needsOcr && request.confirmOnlineOcr !== true) {
    throw new WpsError('OCR_REQUIRED', '这份 PDF 是扫描件，需要先同意 WPS 在线 OCR')
  }
  const scratchRoot = options.scratchRoot ?? path.join(RUN_STATE_ROOT, 'pdf-read')
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(path.join(scratchRoot, 'job-'))
  try {
    const recognize = async () => {
      const output = path.join(scratch, 'recognized.docx')
      const recognized = await runOcrRequest({ action: 'ocr', input, output, confirm: true }, { invoke })
      if (recognized?.verified !== true || !await verifyOfficePackage(output, 'word')) {
        throw new WpsError('OUTPUT_UNVERIFIED', 'WPS OCR 文档结构未获确认')
      }
      const textOutput = path.join(scratch, 'recognized.txt')
      if (options.extractWordText) await options.extractWordText(output, textOutput)
      else await exec('/usr/bin/textutil', ['-convert', 'txt', '-output', textOutput, output], {
        timeout: 60_000, maxBuffer: 64 * 1024,
      })
      const stat = await lstat(textOutput)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200 * 1024 * 1024) {
        throw new WpsError('OCR_TEXT_TOO_LARGE', 'WPS OCR 文字输出超过 200 MB 上限')
      }
      const window = await readTextWindow(textOutput, offset, limit)
      if (!window.hasContent) throw new WpsError('OCR_TEXT_EMPTY', 'WPS OCR 未提取到可供对话使用的文字')
      return { input: request.input, pageCount: details.pageCount, ocr: true, online: true,
        totalCharacters: window.totalCharacters, offset, text: window.text, more: window.more }
    }
    if (needsOcr) return await recognize()
    const output = path.join(scratch, 'text.txt')
    const converted = await invoke({ action: 'run', command: 'pdf2txt', inputs: [input], output,
      options: {}, confirm: true })
    if (converted?.verified !== true) throw new WpsError('OUTPUT_UNVERIFIED', 'WPS PDF 文字提取结果未获确认')
    const stat = await lstat(output)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200 * 1024 * 1024) {
      throw new WpsError('PDF_TEXT_TOO_LARGE', 'PDF 文字输出超过 200 MB 上限')
    }
    const window = await readTextWindow(output, offset, limit)
    if (!window.hasContent) {
      if (request.confirmOnlineOcr !== true) {
        throw new WpsError('OCR_REQUIRED', 'PDF 中没有可提取文字，需要先同意 WPS 在线 OCR')
      }
      return await recognize()
    }
    return { input: request.input, pageCount: details.pageCount, ocr: false,
      totalCharacters: window.totalCharacters, offset, text: window.text, more: window.more }
  } catch (error) {
    if (typeof error?.recoveryPath === 'string') {
      const message = error.code === 'RESULT_UNKNOWN'
        ? `WPS 读取结果未确定；已保留本机暂存供核查：${error.recoveryPath}。请勿立即重试`
        : `${error.message}；已保留 WPS 暂存供核查：${error.recoveryPath}`
      throw new WpsError(error.code ?? 'WPS_ERROR', message)
    }
    throw error
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export async function readImageRequest(request, options = {}) {
  if (request?.confirmOnlineOcr !== true) {
    throw new WpsError('CONFIRM_REQUIRED', '在线 OCR 前需用户明确同意本次图片交给 WPS 处理')
  }
  const input = await checkInput(request.input)
  if (!['.png', '.jpg', '.jpeg'].includes(path.extname(input).toLowerCase())) {
    throw new WpsError('INVALID_INPUT', '图片 OCR 输入须为本机 PNG 或 JPG 文件')
  }
  const invoke = options.invoke ?? runRequest
  const scratchRoot = options.scratchRoot ?? path.join(RUN_STATE_ROOT, 'image-read')
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(path.join(scratchRoot, 'job-'))
  let preserve = false
  try {
    const output = path.join(scratch, 'source.pdf')
    const converted = await invoke({ action: 'run', command: 'photo2pdf', inputs: [input], output,
      options: {}, confirm: true })
    const pdf = converted?.canonicalOutput ?? converted?.output
    const canonicalOutput = await realpath(output).catch(() => null)
    const canonicalPdf = typeof pdf === 'string' ? await realpath(pdf).catch(() => null) : null
    if (converted?.verified !== true || !canonicalOutput || canonicalPdf !== canonicalOutput
        || !await verifyPdf(canonicalPdf)) {
      throw new WpsError('OUTPUT_UNVERIFIED', 'WPS 图片转 PDF 结果未获确认，已停止 OCR')
    }
    const answer = await readPdfRequest({ input: canonicalPdf, forceOcr: true,
      confirmOnlineOcr: true, offset: request.offset, limit: request.limit }, { ...options, invoke })
    return { ...answer, input: request.input, sourceType: 'image',
      ...(converted.warning ? { warning: converted.warning } : {}) }
  } catch (error) {
    preserve = error?.code === 'RESULT_UNKNOWN' || typeof error?.recoveryPath === 'string'
    if (preserve && error instanceof Error && !error.recoveryPath) error.recoveryPath = scratch
    throw error
  } finally {
    if (!preserve) await rm(scratch, { recursive: true, force: true })
  }
}

export async function runRequest(request) {
  if (request?.action === 'ocr') return runOcrRequest(request)
  if (request?.action === 'read_pdf') return readPdfRequest(request)
  if (request?.action === 'read_image') return readImageRequest(request)
  return withCliLock(() => runRequestUnlocked(request))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 1024 * 1024) throw new WpsError('REQUEST_TOO_LARGE', '请求过大')
  }
  try {
    const result = await runRequest(JSON.parse(input))
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: {
      code: error?.code ?? 'WPS_ERROR', message: String(error?.message ?? error).slice(0, 1200),
    } }) + '\n')
  }
}
