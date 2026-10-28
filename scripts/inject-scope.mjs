/**
 * 给每个组件 JSX 的根元素注入作用域类 s-<组件名>。
 *
 * 与 rescope-css 配套：CSS 侧已把每个组件段的选择器加了 `.s-<name>` 前缀，
 * 这里把类名挂到组件根元素上，二者合起来恢复 Vue <style scoped> 的隔离语义。
 *
 * 规则：
 *   - 找到组件函数 return ( 之后第一个 JSX 元素的 className，追加 s-<name>
 *   - 已有 s- 前缀类则跳过（幂等）
 *   - App.tsx 的样式手工平移过，同样处理
 *
 * 用法：node scripts/inject-scope.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.cwd(), 'src', 'components')
const APP = path.join(process.cwd(), 'src', 'App.tsx')

const kebab = (name) =>
  's-' + name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

function inject(source, scopeClass) {
  if (source.includes(scopeClass)) return { source, changed: false }

  // 定位 return ( 之后的第一个 JSX 标签
  const ret = source.search(/return\s*\(/)
  if (ret < 0) return { source, changed: false }
  const tagStart = source.indexOf('<', ret)
  if (tagStart < 0) return { source, changed: false }

  // 元素名（直到空白或 >）
  const afterTag = source.slice(tagStart + 1)
  const tagMatch = afterTag.match(/^([a-zA-Z][\w.-]*)/)
  if (!tagMatch) return { source, changed: false }
  const tag = tagMatch[1]

  // 找这个开始标签的结束（首个未闭合的 >，容忍字符串里的 >，简化处理）
  let i = tagStart + 1 + tag.length
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      break
    }
    i++
  }
  if (i >= source.length) return { source, changed: false }
  const tagBody = source.slice(tagStart, i) // <div className="..." ...（不含 >）

  // 已有 className → 追加；没有 → 插入 className="s-xxx"
  const clsMatch = tagBody.match(/className=\{`([^`]*)`\}/)
  if (clsMatch) {
    const newBody = tagBody.replace(
      /className=\{`([^`]*)`\}/,
      `className={\`$1 ${scopeClass}\`}`,
    )
    return { source: source.slice(0, tagStart) + newBody + source.slice(i), changed: true }
  }
  const clsMatch2 = tagBody.match(/className="([^"]*)"/)
  if (clsMatch2) {
    const newBody = tagBody.replace(
      /className="([^"]*)"/,
      `className="$1 ${scopeClass}"`,
    )
    return { source: source.slice(0, tagStart) + newBody + source.slice(i), changed: true }
  }
  // 无 className：插到标签名后
  const newBody = tagBody.replace(
    new RegExp(`^<${tag.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`),
    `<${tag} className="${scopeClass}"`,
  )
  return { source: source.slice(0, tagStart) + newBody + source.slice(i), changed: true }
}

function main() {
  let touched = 0
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, path: path.join(DIR, f) }))

  for (const { file, path: p } of files) {
    const name = file.replace('.tsx', '')
    if (name === 'DialogIcon') continue // 纯 SVG，样式全局（.dlg-ico）
    const scopeClass = kebab(name)
    const src = fs.readFileSync(p, 'utf8')
    const { source, changed } = inject(src, scopeClass)
    if (changed) {
      fs.writeFileSync(p, source, 'utf8')
      touched++
      console.log(`${file}: +${scopeClass}`)
    }
  }

  // App.tsx（外壳样式平移在 components.css 末尾，无段注释；手工给根加）
  const appSrc = fs.readFileSync(APP, 'utf8')
  if (!appSrc.includes('s-app ')) {
    const { source, changed } = inject(appSrc, 's-app')
    if (changed) {
      fs.writeFileSync(APP, source, 'utf8')
      touched++
      console.log('App.tsx: +s-app')
    }
  }
  console.log(`\n共 ${touched} 个文件注入成功`)
}

main()
