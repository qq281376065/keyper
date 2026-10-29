import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import type { PubsubMessage } from '@shared/types'

/** 消息流保留上限：Pub/Sub 是高频流，无上限会把渲染层拖死 */
const MAX_MESSAGES = 200

/**
 * Pub/Sub 订阅面板：订阅频道 / 模式、发布测试消息、实时查看消息流。
 *
 * 主进程为订阅维护独立连接（订阅模式下连接不能再执行普通命令），
 * 面板关闭 / 切换连接时必须停掉它 —— 这里通过 effect 的清理函数兜底。
 */
export function PubsubCard() {
  const { state, activeConnection, notify } = useRedis()
  useObservable(useSessionStore())

  const connected = activeConnection?.status === 'connected'
  const activeId = state.activeId

  /* ---------------------------------------------------------------- 订阅状态 */
  const [channels, setChannels] = useState<string[]>([])
  const [patterns, setPatterns] = useState<string[]>([])
  const [targetText, setTargetText] = useState('')
  /** true = PSUBSCRIBE 模式订阅（glob：* 任意串、? 单字符） */
  const [asPattern, setAsPattern] = useState(false)
  const [subscribing, setSubscribing] = useState(false)

  const hasSubs = channels.length > 0 || patterns.length > 0
  const subCount = channels.length + patterns.length

  async function subscribe(): Promise<void> {
    const targets = targetText
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!activeId || !targets.length) return
    setSubscribing(true)
    try {
      const res = await api.redis.pubsubSubscribe(activeId, targets, asPattern)
      if (!res.ok) throw new Error(res.error)
      setChannels(res.data.channels)
      setPatterns(res.data.patterns)
      setTargetText('')
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '订阅失败')
    } finally {
      setSubscribing(false)
    }
  }

  async function unsubscribe(target: string, pattern: boolean): Promise<void> {
    if (!activeId) return
    try {
      const res = await api.redis.pubsubUnsubscribe(activeId, [target], pattern)
      if (!res.ok) throw new Error(res.error)
      setChannels(res.data.channels)
      setPatterns(res.data.patterns)
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '退订失败')
    }
  }

  /* ---------------------------------------------------------------- 发布 */
  const [pubChannel, setPubChannel] = useState('')
  const [pubMessage, setPubMessage] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [lastReceivers, setLastReceivers] = useState<number | null>(null)

  async function publish(): Promise<void> {
    const channel = pubChannel.trim()
    if (!activeId || !channel || !pubMessage) return
    setPublishing(true)
    try {
      const res = await api.redis.pubsubPublish(activeId, channel, pubMessage)
      if (!res.ok) throw new Error(res.error)
      setLastReceivers(res.data)
      if (res.data === 0) notify('err', '没有订阅者收到这条消息')
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '发布失败')
    } finally {
      setPublishing(false)
    }
  }

  /* ---------------------------------------------------------------- 消息流 */
  const [messages, setMessages] = useState<PubsubMessage[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)
  /**
   * 当前连接 id 的实时副本：消息回调注册一次，回调里要读到最新 id，
   * 不能闭包捕获首次渲染的 activeId（否则切换连接后过滤条件永远错）。
   */
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    const off = api.redis.onPubsubMessage((message) => {
      /* 多连接并存时只显示当前连接的消息 */
      if (message.connectionId !== activeIdRef.current) return
      setMessages((prev) => {
        const next = [...prev, message]
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next
      })
    })
    return () => off?.()
  }, [])

  /* 新消息自动滚到底部：消息流是「追最新」的阅读模式 */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  function formatTime(ms: number): string {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /* ---------------------------------------------------------------- 停止 / 生命周期 */
  async function stopAll(): Promise<void> {
    if (!activeId) return
    try {
      const res = await api.redis.pubsubStop(activeId)
      if (!res.ok) throw new Error(res.error)
    } catch {
      /* 连接已不存在等情况直接吞掉 —— 面板重置本身不失败 */
    }
    setChannels([])
    setPatterns([])
  }

  function resetPanel(): void {
    setChannels([])
    setPatterns([])
    setMessages([])
    setLastReceivers(null)
  }

  /* 面板销毁（离开概览页）时停掉订阅连接，不留只收不推的幽灵连接 */
  useEffect(() => {
    return () => {
      const id = activeIdRef.current
      if (id) void api.redis.pubsubStop(id).catch(() => {})
    }
  }, [])

  /*
   * 旧 id 变化时先停掉旧连接的订阅连接 —— 不停的话它会一直活着收消息。
   * 本面板「销毁即停订阅」，重挂载后订阅为空，不存在需要恢复的跨面板订阅状态。
   */
  const prevIdRef = useRef(activeId)
  useEffect(() => {
    const prevId = prevIdRef.current
    if (prevId && prevId !== activeId) void api.redis.pubsubStop(prevId).catch(() => {})
    prevIdRef.current = activeId
    resetPanel()
  }, [activeId, connected])

  return (
    <section className="ps-card s-pubsub-card">
      <header className="ps-head">
        <h3 className="ps-title">
          <DialogIcon name="bolt" size={14} className="ps-icon" />
          <span>Pub/Sub 订阅</span>
        </h3>
        <span className="ps-state mono">{hasSubs ? `${subCount} 个订阅` : '未订阅'}</span>
        {connected && hasSubs ? (
          <button className="ps-stop" {...tipProps('断开订阅专用连接（全部订阅一并失效）')} onClick={() => void stopAll()}>
            <DialogIcon name="power" size={12} className="ti" />
            停止
          </button>
        ) : null}
      </header>

      {/* 订阅行：支持一次订阅多个目标（空格 / 逗号分隔） */}
      <div className="ps-row">
        <input
          value={targetText}
          onChange={(event) => setTargetText(event.target.value)}
          className="ps-input grow ps-sub-target"
          placeholder={asPattern ? '模式，如 user:*（空格分隔多个）' : '频道名（空格分隔多个）'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void subscribe()
          }}
        />
        <label className="ps-mode" {...tipProps('按模式订阅（PSUBSCRIBE，支持 * 与 ? 通配）')}>
          <input type="checkbox" checked={asPattern} onChange={(event) => setAsPattern(event.target.checked)} />
          <span>按模式</span>
        </label>
        <button
          className="ps-btn"
          disabled={!connected || subscribing || !targetText.trim()}
          onClick={() => void subscribe()}
        >
          <DialogIcon name="play" size={12} className="ti" />
          {subscribing ? '订阅中…' : '订阅'}
        </button>
      </div>

      {/*
        已订阅清单：频道实底、模式描边，点 × 单个退订。
        没有这块时，"当前订阅了什么"只能靠 ps-state 上的数字猜 ——
        而这个数字既不告诉你是哪个频道，也不给你退订入口，
        只能整组 stopAll 再重新订阅一遍。
      */}
      {hasSubs ? (
        <div className="ps-chips">
          {channels.map((channel) => (
            <span key={`c:${channel}`} className="ps-chip mono" {...tipProps(`频道订阅：${channel}`)}>
              {channel}
              <button
                className="ps-chip-x"
                {...tipProps(`退订 ${channel}`)}
                onClick={() => void unsubscribe(channel, false)}
              >
                <DialogIcon name="close" size={9} />
              </button>
            </span>
          ))}
          {patterns.map((pattern) => (
            <span
              key={`p:${pattern}`}
              className="ps-chip mono pattern"
              {...tipProps(`模式订阅：${pattern}`)}
            >
              {pattern}
              <button
                className="ps-chip-x"
                {...tipProps(`退订模式 ${pattern}`)}
                onClick={() => void unsubscribe(pattern, true)}
              >
                <DialogIcon name="close" size={9} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* 发布测试：发布者视角确认「有没有人在听」（返回接收者数） */}
      <div className="ps-row">
        <input
          value={pubChannel}
          onChange={(event) => setPubChannel(event.target.value)}
          className="ps-input ps-pub-channel"
          placeholder="发布频道"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void publish()
          }}
        />
        <input
          value={pubMessage}
          onChange={(event) => setPubMessage(event.target.value)}
          className="ps-input grow ps-pub-body"
          placeholder="消息内容"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void publish()
          }}
        />
        <button
          className="ps-btn"
          disabled={!connected || publishing || !pubChannel.trim() || !pubMessage}
          onClick={() => void publish()}
        >
          <DialogIcon name="export" size={12} className="ti" />
          {publishing ? '发布中…' : '发布'}
        </button>
        {lastReceivers != null ? (
          <span className="ps-recv mono" {...tipProps('PUBLISH 返回值：收到这条消息的订阅者数量')}>
            {lastReceivers} 个订阅者
          </span>
        ) : null}
      </div>

      <div className="ps-stream-head">
        <span>消息流（{messages.length}）</span>
        {messages.length ? (
          <button className="ps-clear" onClick={() => setMessages([])}>
            <DialogIcon name="clear" size={11} className="ti" />
            清空
          </button>
        ) : null}
      </div>

      <div ref={listRef} className="ps-stream">
        {messages.map((message, index) => (
          <div key={index} className="ps-msg">
            <span className="mono ps-time">{formatTime(message.timestamp)}</span>
            <span
              className={`mono ps-channel${message.kind === 'pmessage' ? ' pattern' : ''}`}
              {...tipProps(message.kind === 'pmessage' ? `模式 ${message.pattern} 命中` : `频道订阅：${message.channel}`)}
            >
              {message.channel}
            </span>
            <span className="ps-payload" {...tipProps(message.payload)}>
              {message.payload}
            </span>
          </div>
        ))}
        {!messages.length ? (
          <div className="ps-empty">订阅后收到的消息会显示在这里；用上方「发布」发一条可立即看到回声</div>
        ) : null}
      </div>
    </section>
  )
}

export default PubsubCard
