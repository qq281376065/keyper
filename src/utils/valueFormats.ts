/**
 * 值查看器的格式检测与解码。
 *
 * 只做纯计算：输入是原始文本或字节，输出是结构化的结果；
 * 不碰 DOM、不发请求，便于单测，也避免把解码逻辑散进组件。
 */

export type ValueFormatId =
  | 'raw'
  | 'json'
  | 'jwt'
  | 'base64'
  | 'php'
  | 'gzip'
  | 'zlib'
  | 'image'
  | 'hex'
  | 'msgpack'

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface ImageInfo {
  mime: string
  ext: string
}

export interface JwtParts {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

export type CompressionKind = 'gzip' | 'zlib'

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function printableTextRatio(text: string): number {
  if (!text.length) return 0
  let printable = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) printable++
  }
  return printable / [...text].length
}

export function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return utf8Decode(base64ToBytes(padded))
}

/** 严格 Base64：字符集、长度、解码后的字节都要能落地 */
export function looksLikeBase64(text: string): boolean {
  const value = text.trim()
  if (value.length < 8 || value.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const bytes = base64ToBytes(value)
    if (!bytes.length) return false
    if (detectImageMime(bytes)) return true
    const decoded = utf8DecodeStrict(bytes)
    if (decoded == null) return false
    return printableTextRatio(decoded) >= 0.85
  } catch {
    return false
  }
}

export function detectImageMime(bytes: Uint8Array): ImageInfo | null {
  const at = (index: number): number => bytes[index] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { mime: 'image/png', ext: 'png' }
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' }
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return { mime: 'image/gif', ext: 'gif' }
  }
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' }
  }
  if (at(0) === 0x42 && at(1) === 0x4d) {
    return { mime: 'image/bmp', ext: 'bmp' }
  }
  return null
}

export function detectCompression(bytes: Uint8Array): CompressionKind | null {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  if (bytes[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(bytes[1] ?? -1)) return 'zlib'
  return null
}

/** 可打印字节占比：ASCII 可打印 + 常见空白，用于区分文本与二进制 */
export function printableRatio(bytes: Uint8Array): number {
  if (!bytes.length) return 0
  let printable = 0
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable++
    }
  }
  return printable / bytes.length
}

export function isJsonText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export function isJwtText(text: string): boolean {
  const parts = text.trim().split('.')
  if (parts.length !== 3) return false
  if (!parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]))
    return !!header && typeof header === 'object' && !Array.isArray(header)
  } catch {
    return false
  }
}

export function isPhpSerialized(text: string): boolean {
  return /^(?:a:\d+:\{|O:\d+:"|s:\d+:"|i:-?\d+;|d:-?\d+(?:\.\d+)?;|b:[01];|N;)/.test(
    text.trim(),
  )
}

/** 文本级可识别的格式（无需原始字节） */
export function detectTextFormats(text: string): ValueFormatId[] {
  if (!text.trim()) return []
  const formats: ValueFormatId[] = []
  if (isJsonText(text)) formats.push('json')
  if (isJwtText(text)) formats.push('jwt')
  if (isPhpSerialized(text)) formats.push('php')
  if (looksLikeBase64(text)) formats.push('base64')
  return formats
}

export function decodeJwt(text: string): DecodeResult<JwtParts> {
  const parts = text.trim().split('.')
  if (parts.length !== 3) return { ok: false, error: 'JWT 需要 3 段' }
  try {
    const header = JSON.parse(base64UrlDecode(parts[0])) as Record<string, unknown>
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>
    if (!header || typeof header !== 'object') return { ok: false, error: 'JWT header 不是对象' }
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'JWT payload 不是对象' }
    return { ok: true, value: { header, payload } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function decodeBase64Text(text: string): DecodeResult<{ text: string; bytes: Uint8Array }> {
  if (!looksLikeBase64(text)) return { ok: false, error: '不是有效的 Base64' }
  try {
    const bytes = base64ToBytes(text)
    const decoded = utf8DecodeStrict(bytes)
    return { ok: true, value: { text: decoded ?? utf8Decode(bytes), bytes } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ---------------------------------------------------------------- PHP serialize */

class PhpReader {
  private pos = 0

  constructor(private readonly text: string) {}

  private peek(): string {
    return this.text[this.pos] ?? ''
  }

  private expect(char: string): void {
    if (this.text[this.pos] !== char) throw new Error(`期望 "${char}"，位置 ${this.pos}`)
    this.pos++
  }

  private readUntil(char: string): string {
    const end = this.text.indexOf(char, this.pos)
    if (end < 0) throw new Error(`缺少 "${char}"`)
    const value = this.text.slice(this.pos, end)
    this.pos = end + 1
    return value
  }

  private readLength(): number {
    return Number(this.readUntil(':'))
  }

  private readString(bytes: number, suffix = ';'): string {
    const start = this.pos
    let consumed = 0
    let end = start
    const encoder = new TextEncoder()
    while (end < this.text.length && consumed < bytes) {
      const code = this.text.codePointAt(end)
      if (code == null) break
      const char = String.fromCodePoint(code)
      consumed += encoder.encode(char).length
      end += char.length
    }
    this.pos = end
    const value = this.text.slice(start, end)
    this.expect('"')
    this.expect(suffix)
    return value
  }

  readValue(depth = 0): unknown {
    if (depth > 64) throw new Error('PHP 反序列化嵌套过深')
    const type = this.peek()
    this.pos++
    switch (type) {
      case 'N':
        this.expect(';')
        return null
      case 'b': {
        this.expect(':')
        const value = this.readUntil(';') === '1'
        return value
      }
      case 'i': {
        this.expect(':')
        return Number(this.readUntil(';'))
      }
      case 'd': {
        this.expect(':')
        return Number(this.readUntil(';'))
      }
      case 's': {
        this.expect(':')
        const length = this.readLength()
        this.expect('"')
        return this.readString(length)
      }
      case 'a': {
        this.expect(':')
        const count = Number(this.readUntil(':'))
        this.expect('{')
        const entries: Array<[string | number, unknown]> = []
        for (let i = 0; i < count; i++) {
          const key = this.readValue(depth + 1)
          const value = this.readValue(depth + 1)
          entries.push([typeof key === 'number' ? key : String(key), value])
        }
        this.expect('}')
        const allNumeric = entries.every(([key], index) => key === index)
        if (allNumeric) return entries.map(([, value]) => value)
        const object: Record<string, unknown> = {}
        entries.forEach(([key, value]) => {
          object[String(key)] = value
        })
        return object
      }
      case 'O': {
        this.expect(':')
        const nameLength = Number(this.readUntil(':'))
        this.expect('"')
        const className = this.readString(nameLength, ':')
        const count = Number(this.readUntil(':'))
        this.expect('{')
        const props: Record<string, unknown> = {}
        for (let i = 0; i < count; i++) {
          const key = this.readValue(depth + 1)
          props[String(key)] = this.readValue(depth + 1)
        }
        this.expect('}')
        return { __class: className, ...props }
      }
      default:
        throw new Error(`不支持的 PHP 类型 "${type}"，位置 ${this.pos - 1}`)
    }
  }

  get done(): boolean {
    return this.pos >= this.text.length
  }
}

export function decodePhpSerialized(text: string): DecodeResult<unknown> {
  const reader = new PhpReader(text.trim())
  try {
    const value = reader.readValue()
    if (!reader.done) return { ok: false, error: '反序列化结束后仍有多余内容' }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ---------------------------------------------------------------- MessagePack（有限子集） */

class MsgpackReader {
  private pos = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private get length(): number {
    return this.bytes.length
  }

  private need(count: number): void {
    if (this.pos + count > this.length) throw new Error('MessagePack 数据不完整')
  }

  private readUint8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  private readUint16(): number {
    this.need(2)
    const value = this.view.getUint16(this.pos)
    this.pos += 2
    return value
  }

  private readUint32(): number {
    this.need(4)
    const value = this.view.getUint32(this.pos)
    this.pos += 4
    return value
  }

  private readUint64(): number {
    this.need(8)
    const value = this.view.getBigUint64(this.pos)
    this.pos += 8
    return Number(value)
  }

  private readInt8(): number {
    this.need(1)
    const value = this.view.getInt8(this.pos)
    this.pos++
    return value
  }

  private readInt16(): number {
    this.need(2)
    const value = this.view.getInt16(this.pos)
    this.pos += 2
    return value
  }

  private readInt32(): number {
    this.need(4)
    const value = this.view.getInt32(this.pos)
    this.pos += 4
    return value
  }

  private readInt64(): number {
    this.need(8)
    const value = this.view.getBigInt64(this.pos)
    this.pos += 8
    return Number(value)
  }

  private readFloat32(): number {
    this.need(4)
    const value = this.view.getFloat32(this.pos)
    this.pos += 4
    return value
  }

  private readFloat64(): number {
    this.need(8)
    const value = this.view.getFloat64(this.pos)
    this.pos += 8
    return value
  }

  private readBytes(count: number): Uint8Array {
    this.need(count)
    const value = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return value
  }

  private readString(count: number): string {
    return utf8Decode(this.readBytes(count))
  }

  private readArray(count: number, depth: number): unknown[] {
    return Array.from({ length: count }, () => this.parse(depth + 1))
  }

  private readMap(count: number, depth: number): Record<string, unknown> {
    const value: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
      const key = this.parse(depth + 1)
      value[typeof key === 'string' ? key : JSON.stringify(key)] = this.parse(depth + 1)
    }
    return value
  }

  private readExt(length: number): Record<string, unknown> {
    const type = this.readInt8()
    const data = this.readBytes(length)
    return { __ext: type, base64: bytesToBase64(data) }
  }

  parse(depth = 0): unknown {
    if (depth > 64) throw new Error('MessagePack 嵌套过深')
    const byte = this.readUint8()
    if (byte <= 0x7f) return byte
    if (byte >= 0xe0) return byte - 0x100
    if ((byte & 0xf0) === 0x80) return this.readMap(byte & 0x0f, depth)
    if ((byte & 0xf0) === 0x90) return this.readArray(byte & 0x0f, depth)
    if ((byte & 0xe0) === 0xa0) return this.readString(byte & 0x1f)

    switch (byte) {
      case 0xc0:
        return null
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xc4:
        return { __bin: bytesToBase64(this.readBytes(this.readUint8())) }
      case 0xc5:
        return { __bin: bytesToBase64(this.readBytes(this.readUint16())) }
      case 0xc6:
        return { __bin: bytesToBase64(this.readBytes(this.readUint32())) }
      case 0xca:
        return this.readFloat32()
      case 0xcb:
        return this.readFloat64()
      case 0xcc:
        return this.readUint8()
      case 0xcd:
        return this.readUint16()
      case 0xce:
        return this.readUint32()
      case 0xcf:
        return this.readUint64()
      case 0xd0:
        return this.readInt8()
      case 0xd1:
        return this.readInt16()
      case 0xd2:
        return this.readInt32()
      case 0xd3:
        return this.readInt64()
      case 0xd9:
        return this.readString(this.readUint8())
      case 0xda:
        return this.readString(this.readUint16())
      case 0xdb:
        return this.readString(this.readUint32())
      case 0xdc:
        return this.readArray(this.readUint16(), depth)
      case 0xdd:
        return this.readArray(this.readUint32(), depth)
      case 0xde:
        return this.readMap(this.readUint16(), depth)
      case 0xdf:
        return this.readMap(this.readUint32(), depth)
      case 0xd4:
        return this.readExt(1)
      case 0xd5:
        return this.readExt(2)
      case 0xd6:
        return this.readExt(4)
      case 0xd7:
        return this.readExt(8)
      case 0xd8:
        return this.readExt(16)
      case 0xc7:
        return this.readExt(this.readUint8())
      case 0xc8:
        return this.readExt(this.readUint16())
      case 0xc9:
        return this.readExt(this.readUint32())
      default:
        throw new Error(`不支持的 MessagePack 标记 0x${byte.toString(16)}`)
    }
  }

  get remaining(): number {
    return this.length - this.pos
  }
}

export function decodeMsgpack(bytes: Uint8Array): DecodeResult<unknown> {
  if (!bytes.length) return { ok: false, error: '空数据' }
  const reader = new MsgpackReader(bytes)
  try {
    const value = reader.parse()
    if (reader.remaining !== 0) return { ok: false, error: '解析结束后仍有多余字节' }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ---------------------------------------------------------------- Hex / 字节统计 */

export interface HexRows {
  rows: string[]
  truncated: boolean
  totalBytes: number
}

export function toHexRows(bytes: Uint8Array, maxBytes = 64 * 1024): HexRows {
  const limit = Math.min(bytes.length, maxBytes)
  const rows: string[] = []
  for (let offset = 0; offset < limit; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, limit))
    const hex = Array.from(slice)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
    const ascii = Array.from(slice)
      .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
      .join('')
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return { rows, truncated: limit < bytes.length, totalBytes: bytes.length }
}

export function nonPrintableRatio(bytes: Uint8Array): number {
  return 1 - printableRatio(bytes)
}
