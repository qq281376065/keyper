import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { t } from '@shared/i18n'

/**
 * 配置目录解析（便携模式优先）。
 *
 * 目标：把 settings.json / connections.json / logs 放在**程序目录旁的 config/**，
 * 这样整个文件夹拷走就能带走全部配置与日志。
 *
 * 但便携模式有个绕不开的现实问题：程序如果装在 `C:\Program Files\`，
 * 或放在只读介质上，那个目录根本不可写。因此这里做一次可写性探测，
 * 失败就回退到 Electron 标准的 userData 目录 —— 宁可配置放在"标准但分散"
 * 的位置，也不能让应用因为写不进配置而起不来。
 *
 * 探测只做一次并缓存：每次读写都去试写文件既慢又会留下垃圾。
 */

const PORTABLE_DIR_NAME = 'config'

let cachedDir: string | null = null
/** 回退时的原因，供界面/日志说明"为什么配置不在程序目录" */
let fallbackReason: string | null = null

/**
 * 程序所在目录。
 * 打包后是 exe 所在目录；开发态是项目根目录（process.cwd() 更贴近习惯）。
 */
function appDir(): string {
  if (app.isPackaged) return path.dirname(app.getPath('exe'))
  return process.cwd()
}

/** 试写一个临时文件来判断目录可写，写完立即删除 */
function canWrite(dir: string): boolean {
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok', 'utf-8')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 解析配置目录（结果缓存）。
 * 顺序：环境变量覆盖 → 程序目录/config → userData
 */
export function configDir(): string {
  if (cachedDir) return cachedDir

  /*
   * 环境变量优先：便于测试与"指定配置目录"的高级用法。
   *
   * 主名是 KEYPER_CONFIG_DIR。仍接受旧名 REDISDOCTER_CONFIG_DIR / REDISDESKTOP_CONFIG_DIR —— 项目早期叫 RedisDesktop，
   * 已有用户的启动脚本 / 部署文档里写的可能是旧名；静默失效会让人以为
   * "指定了目录却没生效"，所以保留一个版本再移除。
   */
  const override =
    process.env.KEYPER_CONFIG_DIR ||
    process.env.REDISDOCTER_CONFIG_DIR ||
    process.env.REDISDESKTOP_CONFIG_DIR
  if (override) {
    if (canWrite(override)) {
      cachedDir = override
      return cachedDir
    }
    fallbackReason = t('configPath.directorySpecifiedEnvironment', { dir: override })
  }

  const portable = path.join(appDir(), PORTABLE_DIR_NAME)
  if (canWrite(portable)) {
    cachedDir = portable
    return cachedDir
  }

  if (!fallbackReason) {
    fallbackReason = t('configPath.appDirectoryNotWritable', { dir: portable })
  }
  cachedDir = app.getPath('userData')
  return cachedDir
}

/** 配置目录的说明信息，供设置界面展示 */
export function configInfo(): { dir: string; portable: boolean; reason: string | null } {
  const dir = configDir()
  const portable = dir !== app.getPath('userData')
  return { dir, portable, reason: fallbackReason }
}

/** 拼接配置目录下的文件路径 */
export function configFile(name: string): string {
  return path.join(configDir(), name)
}
