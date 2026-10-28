import { describe, expect, it } from 'vitest'
import { renamedKey } from '@/utils/renamedKey'

describe('renamedKey', () => {
  it('from 命中前缀则替换', () => {
    expect(renamedKey('user:1001', 'user', 'admin')).toBe('admin:1001')
  })

  it('from 未命中保持原键名', () => {
    expect(renamedKey('sess:1', 'user', 'admin')).toBe('sess:1')
  })

  it('from 留空时给键名加前缀', () => {
    expect(renamedKey('user:1', '', 'backup:')).toBe('backup:user:1')
  })

  it('from 与 to 都留空时原样返回', () => {
    expect(renamedKey('user:1', '', '')).toBe('user:1')
  })

  it('替换后无变化返回原键名（执行侧据此跳过 RENAME 往返）', () => {
    expect(renamedKey('user:1', 'user', 'user')).toBe('user:1')
  })
})