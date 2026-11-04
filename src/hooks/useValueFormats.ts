import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import { t } from '@/i18n'
import {
  base64ToBytes,
  decodeBase64Text,
  decodeJwt,
  decodeMsgpack,
  decodePhpSerialized,
  detectImageMime,
  detectTextFormats,
  toHexRows,
  type ValueFormatId,
} from '@/utils/valueFormats'
import type { ValueBinaryOptions, ValueBinaryResult } from '@shared/types'

export type FormatView =
  | { kind: 'text'; text: string; bytes?: number; truncated?: boolean }
  | { kind: 'hex'; rows: string[]; bytes: number; truncated: boolean }
  | { kind: 'image'; base64: string; mime: string; bytes: number; truncated: boolean }

export interface ValueFormatsApi {
  format: ValueFormatId | null
  view: FormatView | null
  loading: boolean
  error: string | null
  detected: ValueFormatId[]
  select: (format: ValueFormatId | null) => Promise<void>
  reset: () => void
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function useValueFormats(
  keyName: string,
  rawText: string,
  connectionId: string | null,
  engine: 'redis' | 'memcached',
): ValueFormatsApi {
  const [format, setFormat] = useState<ValueFormatId | null>(null)
  const [view, setView] = useState<FormatView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const detected = useMemo(
    () => detectTextFormats(rawText).filter((item) => item !== 'json'),
    [rawText],
  )

  const loadBinary = (options?: ValueBinaryOptions): Promise<{ ok: boolean; data?: ValueBinaryResult; error?: string }> => {
    if (!connectionId) return Promise.resolve({ ok: false, error: t('valueFormats.errorNoConnection') })
    if (engine === 'memcached') return api.memcached.getBinary(connectionId, keyName, options)
    return api.redis.valueBinary(connectionId, keyName, options)
  }

  useEffect(() => {
    seq.current++
    setFormat(null)
    setView(null)
    setError(null)
    setLoading(false)
  }, [keyName])

  function reset(): void {
    seq.current++
    setFormat(null)
    setView(null)
    setError(null)
    setLoading(false)
  }

  async function select(next: ValueFormatId | null): Promise<void> {
    if (!next) {
      reset()
      return
    }
    if (!connectionId || !keyName) return
    const id = ++seq.current
    setFormat(next)
    setLoading(true)
    setError(null)
    setView(null)

    try {
      if (next === 'jwt') {
        const result = decodeJwt(rawText)
        if (!result.ok) throw new Error(result.error)
        setView({ kind: 'text', text: jsonText(result.value) })
      } else if (next === 'php') {
        const result = decodePhpSerialized(rawText)
        if (!result.ok) throw new Error(result.error)
        setView({ kind: 'text', text: jsonText(result.value) })
      } else if (next === 'base64') {
        const result = decodeBase64Text(rawText)
        if (!result.ok) throw new Error(result.error)
        const image = detectImageMime(result.value.bytes)
        if (image) {
          setView({
            kind: 'image',
            base64: rawText.trim(),
            mime: image.mime,
            bytes: result.value.bytes.length,
            truncated: false,
          })
        } else {
          setView({
            kind: 'text',
            text: result.value.text,
            bytes: result.value.bytes.length,
          })
        }
      } else if (next === 'gzip' || next === 'zlib') {
        const res = await loadBinary({ decode: next })
        if (!res.ok || !res.data) throw new Error(res.error ?? t('valueFormats.errorEmpty'))
        if (res.data.decodeError) throw new Error(res.data.decodeError)
        if (res.data.decodedText == null) throw new Error('empty')
        if (id !== seq.current) return
        setView({
          kind: 'text',
          text: res.data.decodedText,
          bytes: res.data.decodedBytes,
          truncated: res.data.truncated,
        })
      } else if (next === 'image') {
        const res = await loadBinary()
        if (!res.ok || !res.data) throw new Error(res.error ?? t('valueFormats.errorEmpty'))
        if (id !== seq.current) return
        const bytes = base64ToBytes(res.data.base64)
        const image = detectImageMime(bytes)
        if (!image) throw new Error(t('valueFormats.errorNotImage'))
        setView({
          kind: 'image',
          base64: res.data.base64,
          mime: image.mime,
          bytes: res.data.bytes,
          truncated: res.data.truncated,
        })
      } else if (next === 'hex') {
        const res = await loadBinary()
        if (!res.ok || !res.data) throw new Error(res.error ?? t('valueFormats.errorEmpty'))
        if (id !== seq.current) return
        const hex = toHexRows(base64ToBytes(res.data.base64))
        setView({
          kind: 'hex',
          rows: hex.rows,
          bytes: res.data.bytes,
          truncated: res.data.truncated || hex.truncated,
        })
      } else if (next === 'msgpack') {
        const res = await loadBinary()
        if (!res.ok || !res.data) throw new Error(res.error ?? t('valueFormats.errorEmpty'))
        if (id !== seq.current) return
        const decoded = decodeMsgpack(base64ToBytes(res.data.base64))
        if (!decoded.ok) throw new Error(decoded.error)
        setView({ kind: 'text', text: jsonText(decoded.value), bytes: res.data.bytes })
      }
    } catch (err) {
      if (id !== seq.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }

  return { format, view, loading, error, detected, select, reset }
}
