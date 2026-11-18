import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROXY,
  buildProxyConfig,
  normalizeProxySettings,
  normalizeProxyUrl,
  parseProxyProbe,
} from '@electron/services/proxy-rules'

describe('normalizeProxyUrl · 代理地址校验', () => {
  it('完整 http 地址原样规范化（去尾斜杠）', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7890/')).toEqual({
      ok: true,
      normalized: 'http://127.0.0.1:7890',
    })
  })

  it('省略协议默认补 http://', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toEqual({
      ok: true,
      normalized: 'http://127.0.0.1:7890',
    })
  })

  it('socks5 协议保留', () => {
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toEqual({
      ok: true,
      normalized: 'socks5://127.0.0.1:1080',
    })
  })

  it('路径/查询/凭据被剥离，只留协议+主机+端口', () => {
    expect(normalizeProxyUrl('http://user:pass@proxy.local:8080/path?q=1')).toEqual({
      ok: true,
      normalized: 'http://proxy.local:8080',
    })
  })

  it('空串拒绝', () => {
    expect(normalizeProxyUrl('')).toEqual({ ok: false, error: 'empty' })
    expect(normalizeProxyUrl('   ')).toEqual({ ok: false, error: 'empty' })
  })

  it('不支持的协议拒绝（ftp/file 等）', () => {
    expect(normalizeProxyUrl('ftp://x:21')).toEqual({ ok: false, error: 'unsupported-protocol' })
  })

  it('非法 URL 拒绝', () => {
    expect(normalizeProxyUrl('http://')).toEqual({ ok: false, error: 'invalid-url' })
  })
})

describe('normalizeProxySettings · 设置收敛', () => {
  it('默认关闭（直连）', () => {
    expect(DEFAULT_PROXY).toEqual({ mode: 'off', url: '' })
    expect(normalizeProxySettings(undefined)).toEqual({ mode: 'off', url: '' })
    expect(normalizeProxySettings(null)).toEqual({ mode: 'off', url: '' })
  })

  it('非法模式回退 off', () => {
    expect(normalizeProxySettings({ mode: 'hack', url: 'x' })).toEqual({ mode: 'off', url: '' })
  })

  it('system 模式保留', () => {
    expect(normalizeProxySettings({ mode: 'system', url: '' })).toEqual({ mode: 'system', url: '' })
  })

  it('manual + 合法地址：规范化保存', () => {
    expect(normalizeProxySettings({ mode: 'manual', url: '127.0.0.1:7890' })).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
    })
  })

  it('manual + 空地址：保留 manual（用户刚切换还没填，输入框要可见）', () => {
    expect(normalizeProxySettings({ mode: 'manual', url: '' })).toEqual({ mode: 'manual', url: '' })
  })

  it('manual + 非法地址：保留 manual 与原值（让用户看到并改正，生效层按直连兜底）', () => {
    expect(normalizeProxySettings({ mode: 'manual', url: 'ftp://x' })).toEqual({
      mode: 'manual',
      url: 'ftp://x',
    })
  })
})

describe('buildProxyConfig · Electron setProxy 配置', () => {
  it('off → direct（显式直连，不被系统代理劫持）', () => {
    expect(buildProxyConfig({ mode: 'off', url: '' })).toEqual({ mode: 'direct' })
  })

  it('system → system', () => {
    expect(buildProxyConfig({ mode: 'system', url: '' })).toEqual({ mode: 'system' })
  })

  it('manual → fixed_servers + 规范化规则', () => {
    expect(buildProxyConfig({ mode: 'manual', url: 'socks5://127.0.0.1:1080' })).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
    })
  })

  it('manual 但地址非法 → direct（不挂在坏配置上）', () => {
    expect(buildProxyConfig({ mode: 'manual', url: 'http://' })).toEqual({ mode: 'direct' })
    expect(buildProxyConfig({ mode: 'manual', url: '' })).toEqual({ mode: 'direct' })
  })
})

describe('parseProxyProbe · 自动检测结果解析', () => {
  it('resolveProxy PROXY 形态', () => {
    expect(parseProxyProbe('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('resolveProxy SOCKS5 形态', () => {
    expect(parseProxyProbe('SOCKS5 127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
  })

  it('resolveProxy DIRECT → null', () => {
    expect(parseProxyProbe('DIRECT')).toBeNull()
  })

  it('PAC 多段取第一段可用', () => {
    expect(parseProxyProbe('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890')
  })

  it('注册表 http=host:port;https=host:port 形态', () => {
    expect(parseProxyProbe('http=127.0.0.1:62793;https=127.0.0.1:62793')).toBe(
      'http://127.0.0.1:62793',
    )
  })

  it('注册表裸 host:port 形态', () => {
    expect(parseProxyProbe('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('空串 / 无效内容 → null', () => {
    expect(parseProxyProbe('')).toBeNull()
    expect(parseProxyProbe('   ')).toBeNull()
  })
})