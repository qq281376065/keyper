import { describe, expect, it } from 'vitest'
import { redactCliSecrets, cliCommandHasSecret } from '@shared/cli-redact'
import { isValidPort } from '@shared/validation'

/**
 * CLI 凭据打码 + 端口校验。
 *
 * 锁定的不变量：
 *   1. AUTH / HELLO AUTH 的密码参数被打码，命令与其余参数原样保留；
 *   2. 非凭据命令一字不改（日志仍可对账）；
 *   3. 引号包裹的密码按参数整体打码，不泄露引号内内容；
 *   4. 端口校验与表单/主进程入口共用同一规则（整数 1-65535）。
 */

describe('cli-redact · AUTH', () => {
  it('单参数 AUTH 打码密码', () => {
    expect(redactCliSecrets('AUTH mySecret123')).toBe('AUTH ***')
  })
  it('双参数 AUTH（ACL 用户名+密码）只打码密码', () => {
    expect(redactCliSecrets('AUTH alice mySecret123')).toBe('AUTH alice ***')
  })
  it('小写命令同样打码', () => {
    expect(redactCliSecrets('auth mySecret123')).toBe('auth ***')
  })
  it('引号密码整体打码', () => {
    expect(redactCliSecrets('AUTH "my secret with spaces"')).toBe('AUTH ***')
  })
  it('裸 AUTH（无参数）原样保留', () => {
    expect(redactCliSecrets('AUTH')).toBe('AUTH')
  })
})

describe('cli-redact · HELLO', () => {
  it('HELLO 3 AUTH user pass 打码两个凭据参数', () => {
    expect(redactCliSecrets('HELLO 3 AUTH alice secret')).toBe('HELLO 3 AUTH *** ***')
  })
  it('HELLO 带 SETNAME 时非凭据参数保留', () => {
    expect(redactCliSecrets('HELLO 3 AUTH alice secret SETNAME myconn')).toBe('HELLO 3 AUTH *** *** SETNAME myconn')
  })
  it('HELLO 不带 AUTH 原样保留', () => {
    expect(redactCliSecrets('HELLO 3')).toBe('HELLO 3')
  })
  it('HELLO 小写 auth 同样打码', () => {
    expect(redactCliSecrets('hello 3 auth alice secret')).toBe('hello 3 auth *** ***')
  })
})

describe('cli-redact · 非凭据命令', () => {
  it('普通命令一字不改', () => {
    expect(redactCliSecrets('GET user:1001')).toBe('GET user:1001')
    expect(redactCliSecrets('  SET key value  ')).toBe('SET key value')
  })
  it('含 AUTH 子串但非命令头不误伤', () => {
    expect(redactCliSecrets('GET AUTH:token')).toBe('GET AUTH:token')
  })
  it('空命令返回空', () => {
    expect(redactCliSecrets('   ')).toBe('')
  })
})

describe('cli-redact · hasSecret', () => {
  it('AUTH 恒 true', () => {
    expect(cliCommandHasSecret('AUTH x')).toBe(true)
    expect(cliCommandHasSecret('auth')).toBe(true)
  })
  it('HELLO 仅带 AUTH 时 true', () => {
    expect(cliCommandHasSecret('HELLO 3 AUTH a b')).toBe(true)
    expect(cliCommandHasSecret('HELLO 3')).toBe(false)
  })
  it('普通命令 false', () => {
    expect(cliCommandHasSecret('GET k')).toBe(false)
  })
})

describe('validation · isValidPort', () => {
  it('合法端口', () => {
    for (const p of [1, 22, 6379, 11211, 65535]) expect(isValidPort(p)).toBe(true)
  })
  it('非法端口', () => {
    for (const p of [0, -1, 65536, 99999, 6379.5, NaN, Infinity]) expect(isValidPort(p)).toBe(false)
  })
  it('非数字类型', () => {
    for (const p of ['6379', '', null, undefined, {}]) expect(isValidPort(p)).toBe(false)
  })
})