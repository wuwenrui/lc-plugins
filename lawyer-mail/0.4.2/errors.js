/**
 * 邮件插件错误类型（纯逻辑，不依赖 cordis / dsh 包）。
 *
 * 纪律（对齐 filing 插件）：
 * - 加载永远成功：账号未绑定、授权码缺失都不在加载期报错，一律推迟到工具调用时 fail-loud；
 * - 每个错误都带中文「怎么办」指引（guidance），模型可原样转告律师；
 * - 错误分类（kind）用于测试与对账：auth=凭据被拒，network=连不上，protocol=服务端返回异常，
 *   config=缺少配置/未绑定，keychain=凭据子系统不可用，args=入参非法，file=落盘被拒，
 *   policy=出域/主机策略拦截。
 */

/** 邮件插件错误的基类：kind + 中文消息 + 可选的修复指引。 */
export class MailError extends Error {
  /**
   * @param {string} kind 错误类别
   * @param {string} message 中文消息（面向律师，可直接展示）
   * @param {{guidance?: string, host?: string, cause?: unknown}} [detail] guidance=下一步怎么办
   */
  constructor(kind, message, detail = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause })
    this.name = 'MailError'
    this.kind = kind
    this.guidance = detail.guidance
    this.host = detail.host
  }
}

/** 入参校验失败（对应 dsh INVALID_ARGS 语义）。 */
export class MailArgsError extends MailError {
  constructor(message, detail) {
    super('args', message, detail)
    this.name = 'MailArgsError'
  }
}

/** 账号/凭据缺失或未绑定：模型应引导律师先绑定邮箱。 */
export class MailAccountError extends MailError {
  constructor(message, detail) {
    super('config', message, detail)
    this.name = 'MailAccountError'
  }
}

/** 凭据子系统（ctx.credentials）不可用：无法安全保存授权码。 */
export class MailKeychainError extends MailError {
  constructor(message, detail) {
    super('keychain', message, detail)
    this.name = 'MailKeychainError'
  }
}

/** 主机策略拦截（明文连接、私网地址未放行等）：请求从未发出。 */
export class MailPolicyError extends MailError {
  constructor(message, detail) {
    super('policy', message, detail)
    this.name = 'MailPolicyError'
  }
}

/** 连接层失败（DNS/拒绝/超时/TLS）。 */
export class MailNetworkError extends MailError {
  constructor(message, detail) {
    super('network', message, detail)
    this.name = 'MailNetworkError'
  }
}

/** 协议层失败（IMAP/SMTP 返回 NO/BAD/5xx，或响应不可解析）。 */
export class MailProtocolError extends MailError {
  constructor(message, detail) {
    super('protocol', message, detail)
    this.name = 'MailProtocolError'
  }
}

/** 附件落盘被拒（越界、超限、危险类型）。 */
export class MailFileError extends MailError {
  constructor(message, detail) {
    super('file', message, detail)
    this.name = 'MailFileError'
  }
}

/** 未绑定任何邮箱时的统一指引（多处复用，措辞固定便于测试与转告）。 */
export const BIND_GUIDANCE =
  '请先用 mail_account_bind 绑定邮箱（需要该邮箱开启 IMAP/SMTP 服务并使用授权码；'
  + 'QQ/163 邮箱在网页版「设置 → 账户」里开启并生成授权码，不要使用网页登录密码）。'
