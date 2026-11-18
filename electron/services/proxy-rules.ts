/**
 * 更新通道的网络代理（纯计算部分，零 Electron 依赖，便于单测）。
 *
 * 代理是可选项：默认 off = 直连，保持历史行为不变。
 * 只作用于版本检查与安装包下载，不影响 Redis / Memcached 连接。
 */
import type { ProxyMode, ProxySettings } from '../../shared/types'

export const DEFAULT_PROXY: ProxySettings = { mode: 'off', url: '' }

/** 支持的代理协议（Electron session.setProxy 的 proxyRules 语法） */
const PROXY_PROTOCOLS = ['http:', 'https:', 'socks4:', 'socks5:']

export type ProxyUrlCheck =
  | { ok: true; normalized: string }
  | { ok: false; error: 'empty' | 'invalid-url' | 'unsupported-protocol' | 'missing-host' }

/**
 * 校验并规范化手动代理地址。
 * 允许省略协议（默认补 http://）；host 必填；端口可选。
 * 返回规范化后的 URL（带协议、去尾斜杠），供 setProxy 与展示共用。
 */
export function normalizeProxyUrl(input: string): ProxyUrlCheck {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: 'empty' }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    return { ok: false, error: 'invalid-url' }
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, error: 'unsupported-protocol' }
  }
  if (!parsed.hostname) return { ok: false, error: 'missing-host' }
  /* 代理地址不该带路径/查询/凭据：只保留协议+主机+端口 */
  const normalized = `${parsed.protocol}//${parsed.host}`
  return { ok: true, normalized }
}

/**
 * 设置收敛：非法模式回退 off。
 *
 * manual 模式的地址处理（修复「点手动被弹回关闭」）：
 *   · 空地址 —— 保留 manual + 空串。用户刚切到手动还没填地址是正常中间态，
 *     输入框要可见可填；此时 buildProxyConfig 按直连处理，不会挂坏配置。
 *   · 非空但非法 —— 同样保留 manual + 原值，让用户能看到自己填了什么并改正；
 *     生效层面 buildProxyConfig 仍按直连兜底。
 *   · 合法 —— 规范化保存。
 * 只有「模式本身非法」才回退 off；地址问题不再连带篡改用户选择的模式。
 */
export function normalizeProxySettings(value: unknown): ProxySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PROXY }
  const raw = value as Partial<ProxySettings>
  const mode: ProxyMode =
    raw.mode === 'system' || raw.mode === 'manual' ? raw.mode : 'off'
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (mode === 'manual') {
    if (!url) return { mode, url: '' }
    const check = normalizeProxyUrl(url)
    return { mode, url: check.ok ? check.normalized : url }
  }
  return { mode, url: mode === 'off' ? '' : url }
}

/**
 * 构建 Electron session.setProxy 的配置。
 *   · off    → mode: 'direct'（显式直连，覆盖系统代理）
 *   · system → mode: 'system'（跟随操作系统代理）
 *   · manual → mode: 'fixed_servers'，proxyRules 为规范化地址
 *
 * 注意 off 用 direct 而不是 system：用户明确选了「关闭」，
 * 就不该再被系统代理劫持 —— 这正是「代理是可选项」的语义。
 */
export type ProxyConfig =
  | { mode: 'direct' }
  | { mode: 'system' }
  | { mode: 'fixed_servers'; proxyRules: string }

export function buildProxyConfig(settings: ProxySettings): ProxyConfig {
  if (settings.mode === 'system') return { mode: 'system' }
  if (settings.mode === 'manual') {
    const check = normalizeProxyUrl(settings.url)
    if (check.ok) return { mode: 'fixed_servers', proxyRules: check.normalized }
    /* 地址非法时退回直连，绝不让更新通道挂在一个坏配置上 */
    return { mode: 'direct' }
  }
  return { mode: 'direct' }
}

/**
 * 从系统代理描述里提取可用的代理地址（自动检测用）。
 *
 * Electron session.resolveProxy 返回形如：
 *   "PROXY 127.0.0.1:7890" / "SOCKS5 127.0.0.1:1080" / "DIRECT"
 *   也可能是分号分隔的多段（PAC 结果），取第一段可用的。
 * Windows 注册表 ProxyServer 可能是 "http=host:port;https=host:port"
 * 或裸 "host:port"，两种都兼容。
 */
export function parseProxyProbe(raw: string): string | null {
  const text = raw.trim()
  if (!text || /^DIRECT$/i.test(text)) return null

  /* resolveProxy 形态：PROXY host:port / SOCKS5 host:port / HTTP host:port */
  const tokenMatch = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i.exec(text.split(';')[0]!.trim())
  if (tokenMatch) {
    const kind = tokenMatch[1]!.toUpperCase()
    const hostPort = tokenMatch[2]!.trim()
    const protocol = kind.startsWith('SOCKS') ? (kind === 'SOCKS4' ? 'socks4' : 'socks5') : 'http'
    const check = normalizeProxyUrl(`${protocol}://${hostPort}`)
    return check.ok ? check.normalized : null
  }

  /* 注册表形态：http=host:port;https=host:port 或裸 host:port */
  const first = text.split(';')[0]!.trim()
  const eq = first.indexOf('=')
  const candidate = eq >= 0 ? first.slice(eq + 1).trim() : first
  if (!candidate) return null
  const check = normalizeProxyUrl(candidate)
  return check.ok ? check.normalized : null
}