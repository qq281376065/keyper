import { useEffect, useState } from 'react'
import { api, isElectron } from '@/api'
import { BrandMark } from '@/components/BrandMark'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { PixelHeading } from '@/components/ui/pixel-heading-character'
import {
  Expandable,
  ExpandableCard,
  ExpandableCardHeader,
  ExpandableContent,
} from '@/components/ui/expandable'
import { BgAnimateButton } from '@/components/ui/bg-animate-button'
import { UpdatePanel } from '@/components/UpdatePanel'
import { useRedis } from '@/store/useRedis'
import { APP_VERSION } from '@/services/errorReport'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import type { EnvInfo } from '@shared/types'

/*
 * 功能清单：把「这工具能干什么」在主页一次讲清楚 —— 新用户建立全貌。
 * 图标全部复用 DialogIcon 既有集（零新增）；文案与实际能力一一对应，
 * 不写没上线的功能。纯静态展示，不发任何数据请求。
 */
const FEATS = [
  { icon: 'text', title: 'welcomePanel.visualizeAllSixTypes', desc: 'welcomePanel.stringHashListSetZset' },
  { icon: 'search', title: 'welcomePanel.searchAllDatabases', desc: 'welcomePanel.scanRunsMainProcessStreamed' },
  { icon: 'link', title: 'welcomePanel.multiHopSshBastion', desc: 'welcomePanel.encryptedCredentialsTunnelKeep' },
  { icon: 'terminal', title: 'welcomePanel.builtCli', desc: 'welcomePanel.tabbedCommandConsolePerConnection' },
  { icon: 'check', title: 'welcomePanel.bulkOperations', desc: 'welcomePanel.bulkDeleteTtlRenamePanel' },
  { icon: 'clock', title: 'common.slowQueryLog', desc: 'welcomePanel.viewSlowCommandRankingsDuration' },
  { icon: 'activity', title: 'common.pubSubSubscriptions', desc: 'welcomePanel.channelPatternSubscriptions' },
  { icon: 'memory', title: 'common.keyMemoryAnalysis', desc: 'welcomePanel.memoryDistributionGroupedPrefixFor' },
  { icon: 'theme', title: 'welcomePanel.nineSkins', desc: 'welcomePanel.darkLightSevenColorSchemes' },
] as const

/* 快捷键速查：与产品真实交互一一对应 */
const KEYS: Array<{ key: MsgKey; desc: MsgKey }> = [
  { key: 'welcomePanel.doubleClickValueArea', desc: 'welcomePanel.enterEditMode' },
  { key: 'welcomePanel.shortcutTabRight', desc: 'welcomePanel.acceptSuggestion' },
  { key: 'welcomePanel.shortcutEsc', desc: 'welcomePanel.cancelEditCollapsePopover' },
  { key: 'welcomePanel.shortcutCtrlEnter', desc: 'welcomePanel.saveEdit' },
]

/**
 * 一张 Cult UI Expandable 外壳卡片（官方四层结构，只做静态展开）。
 *
 * 分层（组件自带，内层不要改）：
 *   motion.div   —— 尺寸容器
 *   外层 div     —— md:rounded-[2rem] + ring-1 + 内阴影（视觉外框）
 *   中间 div     —— md:rounded-[2rem] + md:p-2（外框内 8px 留白）
 *   内层 div     —— md:rounded-3xl + md:p-4 + bg-white/dark:bg-muted（卡片面）
 *
 * 主页现在只保留两张卡片：功能清单（内含九宫格）与底部信息（左右两栏）。
 * 用同一套外壳，是为了两张卡在同一页里看起来是一族，而不是各写一套样式。
 */
function ShellCard({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <Expandable expanded expandBehavior="push" transitionDuration={0.28}>
      <ExpandableCard
        className={`feat-card ${className}`.trim()}
        collapsedSize={{ width: 240, height: 52 }}
        expandedSize={{ width: 240, height: undefined }}
      >
        {children}
      </ExpandableCard>
    </Expandable>
  )
}

/**
 * 九宫格里的单个条目。
 *
 * 保留 ExpandableCardHeader / ExpandableContent 这两个官方子组件，是为了让
 * 条目与"卡片"共享同一套排版语义（头部一行、内容区独立），但它们不再各自
 * 承担外层卡片壳 —— 外层已经由 ShellCard 提供，嵌 9 个 Expandable 会把
 * 圆角与阴影叠 9 层，视觉上变成"卡片里的卡片"。
 */
function FeatItem({ item }: { item: (typeof FEATS)[number] }) {
  const { t } = useI18n()
  return (
    <div className="feat-item">
      <div className="feat-head-row">
        <DialogIcon name={item.icon} size={17} className="feat-icon" />
        <h3>{t(item.title)}</h3>
      </div>
      <p className="feat-desc">{t(item.desc)}</p>
    </div>
  )
}

export interface WelcomePanelProps {
  onNewConnection: () => void
  /** 粘贴连接串导入（由 App 打开导入弹窗） */
  onImportUri: () => void
  /** 打开操作日志面板 */
  onOpenLog: () => void
}

/** 主页标签：Hero + 操作区 + 功能清单卡 + 快捷键 / 兼容性卡 */
export function WelcomePanel({ onNewConnection, onImportUri, onOpenLog }: WelcomePanelProps) {
  const { t } = useI18n()
  const [env, setEnv] = useState<EnvInfo | null>(null)
  const { state } = useRedis()

  /*
   * 主页标签在多标签工作区里不再是"零配置"专属页 —— 用户可能已保存了
   * 一批连接、只是切回了主页。引导文案必须跟着实际状态走：
   * 已有连接时再说"还没有任何连接配置"是明显的误导。
   */
  const hasConnections = state.connections.length > 0

  /** 检查更新面板的展开态：就地展开，不弹模态框打断 */
  const [updateOpen, setUpdateOpen] = useState(false)

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
          {/*
            品牌图标是内联 SVG（BrandMark）：渐变取 --brand-from/--brand-to，
            切皮肤时颜色跟着变；PNG 背景图做不到这一点。
            外层 span 仍负责尺寸（网格两行 + aspect-ratio），组件只管画。
          */}
          <span className="logo">
            <BrandMark />
          </span>
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
            Keyper
          </PixelHeading>
          <p className="subtitle">
            {t('welcomePanel.redisDesktopManagementTool')}
            <span className="dot">·</span>v{env?.appVersion ?? APP_VERSION}
            <span className="dot">·</span>
            {isElectron ? t('welcomePanel.electronRuntime') : t('welcomePanel.browserPreviewMode')}
          </p>
        </header>

        <div className="cta">
          {/*
            新建连接：Cult UI Background Animate Button，官方结构与参数不动，
            只把渐变从写死的 candy 换成 theme。

            原来是 candy（#ff9a9e→#fad0c4 固定粉），九套皮肤下永远是同一个颜色，
            放在墨绿/深蓝界面上很突兀。theme 走 --cta-a/--cta-b 两个变量，
            由各主题在 main.css 里配「同色相的浅渐变」，文字色取 --cta-fg。

            参数全部取官方示例的值：rounded="full"（胶囊）+ shadow="soft"
            + animation="spin"（4s 匀速）。只把渐变从写死的 candy 换成 theme，
            让颜色跟着皮肤走；除此之外不加任何额外样式（描边、内阴影、自定义阴影
            都试过并已撤掉），tailwind-cards.css 里只留 cursor 与键盘焦点环两条
            非视觉规则。
          */}
          <BgAnimateButton
            className="cta-animate"
            size="lg"
            rounded="full"
            shadow="soft"
            gradient="theme"
            animation="spin"
            onClick={onNewConnection}
          >
            <DialogIcon name="add" size={15} />
            {t('common.newConnection')}
          </BgAnimateButton>

          {/*
            次级操作：与主按钮同一行、同一高度，但在视觉上明显更轻
            （描边 + 透明底）。这三件事都是"围绕连接的一次性动作"，
            放在主页起步位置比埋进顶栏图标更容易被发现。

            顺序按使用频率排：粘贴连接串（拿到别人给的地址时最快）
            → 操作日志（连不上时第一时间来看）→ 检查更新。
          */}
          <div className="cta-secondary">
            <button className="cta-sec-btn" onClick={onImportUri} {...tipProps(t('welcomePanel.pasteRedis'))}>
              <DialogIcon name="link" size={14} />
              {t('welcomePanel.pasteConnectionString')}
            </button>
            <button className="cta-sec-btn" onClick={onOpenLog} {...tipProps(t('welcomePanel.viewConnectionsActivityLog'))}>
              <DialogIcon name="activity" size={14} />
              {t('common.activityLog')}
            </button>
            <button
              className={`cta-sec-btn${updateOpen ? ' is-open' : ''}`}
              onClick={() => setUpdateOpen((prev) => !prev)}
              {...tipProps(t('welcomePanel.checkForNewVersion'))}
              aria-expanded={updateOpen}
            >
              <DialogIcon name="refresh" size={14} />
              {t('updatePanel.checkForUpdates')}
            </button>
            {updateOpen ? <UpdatePanel onClose={() => setUpdateOpen(false)} /> : null}
          </div>
          {/*
            只在"一个连接都没有"时给一句起步提示。
            已经有连接时不再提示"从左侧列表选一个" —— 用户既然有连接，
            自然知道去哪点；这句在常驻状态下反而是一直占位的噪音。
          */}
          {!hasConnections ? (
            <span className="cta-hint">{t('welcomePanel.noConnectionsConfiguredYet')}</span>
          ) : null}
        </div>

        {/*
          功能清单卡：一张卡片，内部是九宫格。
          九项全部直接展示完整说明，不做折叠 —— 这里是"能力清单"，
          用户来主页就是想一次看全，不该再让他们逐个点开。
        */}
        {/*
          两张卡各被 Expandable 包了一层 div，彼此不是兄弟节点，
          间距不能靠 `+` 选择器给，这里用一个 flex 容器统一控制。
        */}
        <div className="card-stack">
        <ShellCard className="feat-sheet-card">
          <ExpandableCardHeader className="feat-sheet-head">
            <div className="feat-sheet-title-row">
              <h2 className="card-title">{t('welcomePanel.features')}</h2>
              <span className="feat-sheet-count">{t('memcachedOverview.countItems', { count: FEATS.length })}</span>
            </div>
          </ExpandableCardHeader>
          <ExpandableContent preset="slide-up" stagger>
            <div className="feat-grid">
              {FEATS.map((item) => (
                <FeatItem key={item.title} item={item} />
              ))}
            </div>
          </ExpandableContent>
        </ShellCard>

        {/*
          底部信息卡：一张卡片，内部左右两栏 —— 左「快捷键速查」右「兼容与性能」。
          两栏内容一短一长，用等高布局保证中间的分隔线贯穿整卡。
        */}
        <ShellCard className="info-card">
          <div className="info-grid">
            {/* ------------------------------------------------ 快捷键速查 */}
            <section className="info-col">
              <h2 className="card-title">{t('welcomePanel.keyboardShortcuts')}</h2>
              <table className="keys-table">
                <tbody>
                  {KEYS.map((item) => (
                    <tr key={item.key}>
                      <td className="key-cell">{t(item.key)}</td>
                      <td className="desc">{t(item.desc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* ------------------------------------------------ 兼容与性能 */}
            <section className="info-col">
              <h2 className="card-title">{t('welcomePanel.compatibilityPerformance')}</h2>
              <ul className="compat-list">
                <li>
                  <DialogIcon name="server" size={13} className="compat-item-icon" />
                  <span>
                    {t('welcomePanel.standaloneSupported')} <strong>Redis 7.x</strong> {t('welcomePanel.later')}
                  </span>
                </li>
                <li>
                  <DialogIcon name="memory" size={13} className="compat-item-icon" />
                  <span>
                    {t('welcomePanel.alsoSupports')} <strong>Memcached</strong>
                    {t('welcomePanel.memcachedCapabilitySuffix')}
                  </span>
                </li>
                <li>
                  <DialogIcon name="bolt" size={13} className="compat-item-icon" />
                  <span>
                    {t('welcomePanel.redisKeyBrowsingUses')} <strong>{t('welcomePanel.incrementalScan')}</strong>
                    {t('welcomePanel.withoutBlockingServerMemcached')}
                  </span>
                </li>
                <li>
                  <DialogIcon name="eye-off" size={13} className="compat-item-icon" />
                  <span>
                    {t('welcomePanel.credentialsStoredSystemKeychain')} <strong>{t('welcomePanel.encryptedStorage')}</strong>
                  </span>
                </li>
              </ul>
            </section>
          </div>
        </ShellCard>
        </div>
      </div>
    </section>
  )
}

export default WelcomePanel
