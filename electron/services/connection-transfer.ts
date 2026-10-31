import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ConnectionTransferFile, ParsedTransfer } from '../../shared/connection-transfer'
import { MAX_TRANSFER_FILE_BYTES } from '../../shared/connection-transfer'
import { t } from '@shared/i18n'

/**
 * 连接导入导出的主进程侧实现：文件读写 + 一次性预览令牌。
 *
 * 解析 / 合并等纯逻辑在 shared/connection-transfer.ts ——
 * 浏览器预览的 mock 与单元测试复用同一套规则，这里只做 IO。
 */

export * from '../../shared/connection-transfer'

const IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000

export interface PendingImport {
  parsed: ParsedTransfer
  fileName: string
  createdAt: number
}

const pendingImports = new Map<string, PendingImport>()

export function stashImport(parsed: ParsedTransfer, fileName: string): string {
  /* 顺手清理过期令牌，避免用户长时间开着预览时缓存无限堆积 */
  const now = Date.now()
  for (const [key, value] of pendingImports) {
    if (now - value.createdAt > IMPORT_TOKEN_TTL_MS) pendingImports.delete(key)
  }
  const token = randomUUID()
  pendingImports.set(token, { parsed, fileName, createdAt: now })
  return token
}

export function takeImport(token: string): PendingImport {
  const pending = pendingImports.get(token)
  pendingImports.delete(token)
  if (!pending || Date.now() - pending.createdAt > IMPORT_TOKEN_TTL_MS) {
    throw new Error(t('connectionTransfer.previewExpired'))
  }
  return pending
}

export function dropImport(token: string): void {
  pendingImports.delete(token)
}

export function readTransferFile(filePath: string): string {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(t('connectionTransfer.notAFile'))
  if (stat.size > MAX_TRANSFER_FILE_BYTES) {
    throw new Error(
      t('connectionTransfer.fileTooLarge', { max: Math.round(MAX_TRANSFER_FILE_BYTES / 1024 / 1024) }),
    )
  }
  return fs.readFileSync(filePath, 'utf-8')
}

export function writeTransferFile(filePath: string, file: ConnectionTransferFile): void {
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
}
