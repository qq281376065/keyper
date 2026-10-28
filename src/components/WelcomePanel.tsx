import { useEffect, useState } from 'react'
import { api, isElectron } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { PixelHeading } from '@/components/ui/pixel-heading-character'
import {
  Expandable,
  ExpandableCard,
  ExpandableCardHeader,
  ExpandableContent,
  ExpandableTrigger,
  useExpandable,
} from '@/components/ui/expandable'
import { useRedis } from '@/store/useRedis'
import { APP_VERSION } from '@/services/errorReport'
import type { EnvInfo } from '@shared/types'

/*
 * 功能导览九宫格：把「这工具能干什么」在主页一次讲清楚 —— 新用户建立全貌。
 * 图标全部复用 DialogIcon 既有集（零新增）；文案与实际能力一一对应，
 * 不写没上线的功能。纯静态展示，不发任何数据请求。
 */
const FEATS = [
  { icon: 'text', title: '六类型可视化', desc: 'string / hash / list / set / zset / stream 全部支持浏览与编辑' },
  { icon: 'search', title: '全库搜索', desc: 'SCAN 下沉主进程，进度推送可中止，历史记录自动补全' },
  { icon: 'link', title: 'SSH 多级跳板', desc: '凭据加密存储 + 隧道保活，生产实例也能安全直连' },
  { icon: 'terminal', title: '内置 CLI', desc: '按连接分标签的命令行控制台，任意命令直达' },
  { icon: 'check', title: '批量操作', desc: '删除 / TTL / 重命名批量面板，进度可见可中止' },
  { icon: 'clock', title: '慢查询日志', desc: '实时查看慢命令排行与耗时分布' },
  { icon: 'activity', title: 'Pub/Sub 订阅', desc: '频道与模式订阅，发布测试即时回显' },
  { icon: 'memory', title: '键内存分析', desc: '前缀聚合内存分布，容量排查一眼定位' },
  { icon: 'theme', title: '9 套皮肤', desc: '暗色 / 亮色 / 七套配色皮肤，明暗档随主题切换' },
] as const

/**
 * 折叠箭头：跟随 Expandable 的展开态翻转。
 * 用 useExpandable() 读状态而不是自己维护一份 —— 组件支持受控/非受控
 * 两种用法，自存状态会与"只点 trigger"的场景脱节。
 */
function ChevronSlot() {
  const { isExpanded } = useExpandable()
  return (
    <span className={`feat-chevron${isExpanded ? ' is-open' : ''}`} aria-hidden>
      <svg viewBox="0 0 12 12" width="12" height="12">
        <path
          d="M3 4.5L6 7.5L9 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/* 快捷键速查：与产品真实交互一一对应 */
const KEYS: Array<{ key: string; desc: string }> = [
  { key: '双击值区域', desc: '进入编辑' },
  { key: 'Tab / →', desc: '采纳搜索补全' },
  { key: 'Esc', desc: '取消编辑 / 收起浮层' },
  { key: 'Ctrl+Enter', desc: '保存编辑' },
]

/** 主页标签：Hero + 新建连接 + 功能导览九宫格 + 快捷键 / 兼容性卡片 */
export function WelcomePanel({ onNewConnection }: { onNewConnection: () => void }) {
  const [env, setEnv] = useState<EnvInfo | null>(null)
  const { state } = useRedis()

  /*
   * 主页标签在多标签工作区里不再是"零配置"专属页 —— 用户可能已保存了
   * 一批连接、只是切回了主页。引导文案必须跟着实际状态走：
   * 已有连接时再说"还没有任何连接配置"是明显的误导。
   */
  const hasConnections = state.connections.length > 0

  useEffect(() => {
    void (async () => {
      const res = await api.app.getEnvInfo()
      if (res.ok) setEnv(res.data)
    })()
  }, [])

  return (
    <section className="welcome s-welcome-panel">
      <div className="inner">
        {/*
          结构说明：hero 是 2 行 × 2 列的网格。
            第 1 列：logo 跨两行，高度 = 标题行 + 副标题行（由内容撑开）
            第 2 列：第 1 行大标题、第 2 行小标题
          三个元素因此是**同级**的 grid 子项，不能再包一层 .hero-text ——
          多一层包裹会让 logo 只能撑满"那一层"的高度，而不是两行之和。
        */}
        <header className="hero">
          <span className="logo">R</span>
          {/*
            主页标题用 Cult UI 的 PixelHeading（Char）。
            五个 Geist 像素字体按黄金比例铺开，hover / focus 时逐字错峰切换。

            mode="random"：静止态是黄金比例分布，动起来每个字符独立打乱 ——
            比 uniform 的"整词一起换"更像"活的数据"，契合 Redis 工具的气质。
            autoPlay：进主页即开始播放，不需要悬停。它是主页唯一的动效，
            且周期 150ms/字、错峰 50ms，节奏接近"数据在呼吸"而不是闪烁；
            系统开启「减少动态效果」时组件会自动停摆（见 pixel-heading-character）。
            客户端的 prefersReducedMotion 判断同时覆盖 autoPlay 与悬停两条路径。

            px-grad-ember 是 Ember Duotone 预设（暖红→琥珀→粉→紫），
            深浅主题各一套色值，见 src/styles/tailwind.css。
          */}
          <PixelHeading
            as="h2"
            mode="random"
            autoPlay
            className="px-title px-grad-ember welcome-title"
          >
            RedisDocter
          </PixelHeading>
          <p className="subtitle">
            Redis 桌面管理工具
            <span className="dot">·</span>v{env?.appVersion ?? APP_VERSION}
            <span className="dot">·</span>
            {isElectron ? 'Electron 运行时' : '浏览器预览模式'}
          </p>
        </header>

        <div className="cta">
          <button className="btn-primary btn-lg" onClick={onNewConnection}>
            <DialogIcon name="add" size={15} />
            新建连接
          </button>
          <span className="cta-hint">
            {hasConnections ? '从左侧连接列表选择一个实例即可开始' : '还没有任何连接配置，添加一个 Redis 实例即可开始'}
          </span>
        </div>

        {/*
          功能导览九宫格：静态特性卡（hover 提亮但不跳转 —— 卡片是说明
          不是入口，入口都在连接后的工作区里）。3 列 × 3 行。
        */}
        <div className="feat-grid">
          {FEATS.map((item) => (
            <Expandable key={item.title} transitionDuration={0.28} expandBehavior="push">
              <ExpandableCard
                className="feat-card"
                collapsedSize={{ width: 240, height: 52 }}
                expandedSize={{ width: 240, height: undefined }}
              >
                <ExpandableTrigger>
                  <ExpandableCardHeader className="feat-head">
                    <DialogIcon name={item.icon} size={18} className="feat-icon" />
                    <h3>{item.title}</h3>
                    <ChevronSlot />
                  </ExpandableCardHeader>
                </ExpandableTrigger>
                <ExpandableContent preset="slide-up" stagger>
                  <p className="feat-desc">{item.desc}</p>
                </ExpandableContent>
              </ExpandableCard>
            </Expandable>
          ))}
        </div>

        <div className="cards">
          {/* ---------------------------------------------------- 快捷键速查 */}
          <article className="card">
            <h2>快捷键速查</h2>
            <table className="keys-table">
              <tbody>
                {KEYS.map((item) => (
                  <tr key={item.key}>
                    <td className="key-cell">{item.key}</td>
                    <td className="desc">{item.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          {/* ---------------------------------------------------- 兼容与性能 */}
          <article className="card">
            <h2>兼容与性能</h2>
            <ul className="compat-list">
              <li>
                <DialogIcon name="server" size={13} className="compat-item-icon" />
                <span>
                  支持单机 <strong>Redis 7.x</strong> 及以上版本
                </span>
              </li>
              <li>
                <DialogIcon name="bolt" size={13} className="compat-item-icon" />
                <span>
                  键浏览采用 <strong>SCAN 渐进式遍历</strong>，不会阻塞服务端
                </span>
              </li>
              <li>
                <DialogIcon name="eye-off" size={13} className="compat-item-icon" />
                <span>
                  连接凭据经系统钥匙串 <strong>加密存储</strong>
                </span>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  )
}

export default WelcomePanel
