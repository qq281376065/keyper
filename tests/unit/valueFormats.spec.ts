import { describe, expect, it } from 'vitest'
import {
  decodeBase64Text,
  decodeJwt,
  decodeMsgpack,
  decodePhpSerialized,
  detectCompression,
  detectImageMime,
  detectTextFormats,
  isJsonText,
  looksLikeBase64,
  nonPrintableRatio,
  toHexRows,
} from '@/utils/valueFormats'

const encoder = new TextEncoder()

function toBase64(text: string): string {
  const bytes = encoder.encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function toBase64Url(text: string): string {
  return toBase64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('detectTextFormats', () => {
  it('识别 JSON / JWT / Base64 / PHP', () => {
    expect(detectTextFormats('{"a":1}')).toContain('json')
    const jwt = `${toBase64Url('{"alg":"HS256"}')}.${toBase64Url('{"sub":"1"}')}.sig`
    expect(detectTextFormats(jwt)).toContain('jwt')
    expect(detectTextFormats(toBase64('hello world'))).toContain('base64')
    expect(detectTextFormats('a:1:{s:2:"id";i:1;}')).toContain('php')
  })

  it('普通文本不误判', () => {
    expect(detectTextFormats('hello world')).toEqual([])
    expect(isJsonText('not json')).toBe(false)
    expect(looksLikeBase64('abcd')).toBe(false)
  })

  it('Base64 中文可还原为文本', () => {
    const encoded = toBase64('键值缓存')
    expect(looksLikeBase64(encoded)).toBe(true)
    const decoded = decodeBase64Text(encoded)
    expect(decoded.ok && decoded.value.text).toBe('键值缓存')
  })
})

describe('decodeJwt', () => {
  it('解出 header / payload', () => {
    const token = [
      toBase64Url('{"alg":"HS256","typ":"JWT"}'),
      toBase64Url('{"sub":"user-1","exp":1700000000}'),
      'signature',
    ].join('.')
    const result = decodeJwt(token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.alg).toBe('HS256')
    expect(result.value.payload.sub).toBe('user-1')
  })

  it('格式错误返回失败', () => {
    expect(decodeJwt('a.b').ok).toBe(false)
    expect(decodeJwt('a.b.c').ok).toBe(false)
  })
})

describe('decodePhpSerialized', () => {
  it('数组与标量', () => {
    const result = decodePhpSerialized(
      'a:4:{s:4:"name";s:5:"Alice";s:3:"age";i:30;s:7:"enabled";b:1;s:5:"score";d:9.5;}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ name: 'Alice', age: 30, enabled: true, score: 9.5 })
  })

  it('索引数组还原为数组', () => {
    const result = decodePhpSerialized('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')
    expect(result.ok && result.value).toEqual(['a', 'b'])
  })

  it('对象带类名', () => {
    const result = decodePhpSerialized('O:8:"stdClass":1:{s:2:"id";i:1;}')
    expect(result.ok && result.value).toEqual({ __class: 'stdClass', id: 1 })
  })

  it('null 与非法输入', () => {
    expect(decodePhpSerialized('N;').ok).toBe(true)
    expect(decodePhpSerialized('a:1:{').ok).toBe(false)
  })
})

describe('decodeMsgpack', () => {
  it('map / array / 布尔', () => {
    const map = decodeMsgpack(new Uint8Array([0x81, 0xa1, 0x61, 0x01]))
    expect(map.ok && map.value).toEqual({ a: 1 })

    const array = decodeMsgpack(
      new Uint8Array([0x93, 0x01, 0xa2, 0x68, 0x69, 0xc3]),
    )
    expect(array.ok && array.value).toEqual([1, 'hi', true])
  })

  it('binary 以 base64 呈现', () => {
    const result = decodeMsgpack(new Uint8Array([0xc4, 0x03, 0x01, 0x02, 0x03]))
    expect(result.ok && result.value).toEqual({ __bin: 'AQID' })
  })

  it('不完整数据返回失败', () => {
    expect(decodeMsgpack(new Uint8Array([0x92, 0x01])).ok).toBe(false)
    expect(decodeMsgpack(new Uint8Array()).ok).toBe(false)
  })
})

describe('二进制识别', () => {
  it('图片与压缩魔数', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))?.mime).toBe('image/png')
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff]))?.mime).toBe('image/jpeg')
    expect(detectCompression(new Uint8Array([0x1f, 0x8b]))).toBe('gzip')
    expect(detectCompression(new Uint8Array([0x78, 0x9c]))).toBe('zlib')
    expect(detectCompression(new Uint8Array([0x00, 0x01]))).toBeNull()
  })

  it('Hex 行与截断', () => {
    const bytes = new Uint8Array(20).fill(0x41)
    const hex = toHexRows(bytes, 16)
    expect(hex.rows).toHaveLength(1)
    expect(hex.truncated).toBe(true)
    expect(hex.rows[0]).toContain('41 41 41')
    expect(hex.rows[0].endsWith('AAAAAAAAAAAAAAAA')).toBe(true)
    expect(toHexRows(new Uint8Array([0x00, 0x41])).rows[0].endsWith('.A')).toBe(true)
  })

  it('不可打印占比', () => {
    expect(nonPrintableRatio(new Uint8Array([0x00, 0x01]))).toBe(1)
    expect(nonPrintableRatio(encoder.encode('abc'))).toBe(0)
  })
})
