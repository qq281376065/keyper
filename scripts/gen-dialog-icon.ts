/**
 * 从 DialogIcon.vue 提取图标分支，生成 React 版 DialogIcon.tsx。
 *
 * 为什么用「逐条 if + return」而不是多层三元：
 * 60+ 分支的三元链会把注释挤进表达式中间（`? (` 与 `) : (` 之间），
 * JSX 注释在该位置非法，编译直接报错；且注释一旦与表达式同行，
 * 会把表达式头部吞进注释里 —— 图标位置退化成显示源码文本
 * （构建仍能通过，是更隐蔽的一类缺陷）。
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), '..', 'RedisDesktop', 'src', 'components', 'DialogIcon.vue')
const OUT = path.join(process.cwd(), 'src', 'components', 'DialogIcon.tsx')

const text = fs.readFileSync(SRC, 'utf8')
const propsBlock = text.match(/defineProps<\{([\s\S]*?)\}>\(\)/)?.[1] ?? ''
const typeBlock = propsBlock.replace(/size\?: number/, '').replace(/name\s*:/, '').trim()
const svg = text.slice(text.indexOf('<svg'), text.lastIndexOf('</svg>'))

interface Branch {
  name: string
  body: string
  comment: string
}

const branches: Branch[] = []
const re = /(<g (?:v-if|v-else-if)="name === '([a-z-]+)'">([\s\S]*?)<\/g>)|(<!--([\s\S]*?)-->)/g
let m: RegExpExecArray | null
let pendingComment = ''
while ((m = re.exec(svg))) {
  if (m[4] !== undefined) {
    pendingComment = m[5]!.trim()
    continue
  }
  branches.push({ name: m[2]!, body: m[3]!.trim(), comment: pendingComment })
  pendingComment = ''
}

/** 路径数据里的多余空白归一化 */
const clean = (body: string): string =>
  body
    .replace(/\s+\/>/g, ' />')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

/** SVG 属性名转 React 驼峰 */
const CAMEL: Array<[RegExp, string]> = [
  [/\sclass=/g, ' className='],
  [/\sstroke-dasharray=/g, ' strokeDasharray='],
  [/\sstroke-width=/g, ' strokeWidth='],
  [/\sstroke-linecap=/g, ' strokeLinecap='],
  [/\sstroke-linejoin=/g, ' strokeLinejoin='],
  [/\sfill-rule=/g, ' fillRule='],
  [/\sclip-rule=/g, ' clipRule='],
  [/\sstop-color=/g, ' stopColor='],
  [/\stext-anchor=/g, ' textAnchor='],
  [/\sfont-size=/g, ' fontSize='],
]

const glyph: string[] = []
for (const b of branches) {
  if (b.comment) {
    glyph.push(`  /** ${b.comment.replace(/\*\//g, '')} */`)
  }
  glyph.push(`  if (name === '${b.name}') {`)
  glyph.push('    return (')
  glyph.push('      <g>')
  let body = clean(b.body)
  for (const [pattern, replacement] of CAMEL) body = body.replace(pattern, replacement)
  for (const part of body.split('\n')) glyph.push(`        ${part}`)
  glyph.push('      </g>')
  glyph.push('    )')
  glyph.push('  }')
}

const typeLines = typeBlock
  .split('\n')
  .map((line) => line.replace(/^\s*\|/, '  |').trimEnd())
  .filter((line) => line.trim())
  .join('\n')

const out = `/**
 * 弹窗 / 按钮内的前置图标（语义命名，全部内联 SVG）。
 *
 * 为什么做成组件而不是各处内联 SVG：
 * 同一套图标要出现在十几个弹窗的按钮里，
 * 内联会把上百行重复的路径数据散落到各文件，改一处颜色/粗细要改几十处。
 *
 * 图标按**语义**命名而非形状（如 \`save\` 而非 \`floppy\`）：
 * 调用方关心的是"这个按钮在做什么"，形状调整时不必回头改所有调用。
 *
 * 统一规格：16×16 viewBox、\`stroke: currentColor\`（跟随按钮文字色）、
 * 1.5 的描边宽度（比表格行内图标略粗，因为弹窗按钮字号更大）。
 */
export type DialogIconName =
${typeLines}

export interface DialogIconProps {
  name: DialogIconName
  /** 尺寸（px），默认 13 */
  size?: number
  /** 额外类名（用于颜色 / 旋转等局部修饰） */
  className?: string
}

/** 图标查找：逐条 if + return（理由见文件头注释） */
function renderGlyph(name: DialogIconName): React.ReactElement | null {
${glyph.join('\n')}
  return null
}

export function DialogIcon({ name, size, className }: DialogIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className ? \`dlg-ico \${className}\` : 'dlg-ico'}
      style={{ width: \`\${size ?? 13}px\`, height: \`\${size ?? 13}px\` }}
      aria-hidden="true"
    >
      {renderGlyph(name)}
    </svg>
  )
}

export default DialogIcon
`

fs.writeFileSync(OUT, out, 'utf8')
console.log('branches', branches.length, 'bytes', out.length)
