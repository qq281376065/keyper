import { describe, expect, it } from 'vitest'
import {
  DICTIONARIES,
  LOCALES,
  LOCALE_NAMES,
  detectLocale,
  isLocale,
  normalizeLocale,
  translate,
} from '@shared/i18n'

const CJK = /[\u3400-\u9fff]/
/** 语言本名不翻译：英文界面下仍是「简体中文」「繁體中文」 */
const ENDONYMS = new Set(['简', '繁', '简体中文', '繁體中文'])

const PLACEHOLDER = /\{(\w+)\}/g

function placeholders(text: string): string {
  return [...text.matchAll(PLACEHOLDER)]
    .map((m) => m[1])
    .sort()
    .join(',')
}

/**
 * 高频简体专用字。zh-TW 译文里出现这些字，基本可以判定是漏转。
 *
 * 只收「繁体不会用到的字」：
 *   - 「台」「出」「量」等繁简同形字不在列；
 *   - 「除」「置」「後/后」「雲/云」等简繁都合法的字也不在列 ——
 *     删除、设置、位置在繁体里本来就写作原样，收进来全是误报。
 */
const SIMPLIFIED_ONLY =
  '连线数据设关闭单双击复删键项层级筛选载储读网错误权录执检状态时间钟续训练备测试计费务机迟异体监视图览创编辑约减缩进择确认内优杂这个为会后来们买门长问题见让对该将无与从识别寻带帮标签记缓冲击终开启断满远稳类参变职广庆库废弃张弹归当彻户扩扫护报换损摄摆摇拨涨爱办币毕补财产销偿场车称处触传纯词辞达贷导岛灯电调顶订东动独队夺额饿儿发罚烦饭访飞纷风丰负妇盖赶刚钢纲给宫贡沟构购够顾观馆惯贯规龟轨贵滚锅国汉贺红坏欢环还挥辉毁汇绘获货积鸡极挤纪际继价驾简讲奖较阶节洁结紧仅尽经静镜旧举剧军课块宽矿况亏阔兰蓝栏劳乐离礼历联链两疗临铃灵领龙楼陆虑乱轮论罗马码吗猫贸么没梦弥灭难脑宁农欧盘赔喷频贫评铺齐骑气迁钱浅墙桥亲轻请穷区劝热荣软赛杀晒闪声胜师湿实势适释输书属术树谁顺说丝苏诉虽随岁孙锁贪谈汤讨腾条铁听铜统头团脱万围维伟卫温闻习戏细显险现献县详响销晓协写谢兴须许悬学询讯压亚严颜艳验杨阳养样药爷页业叶医遗仪艺亿义议译银饮营赢邮犹鱼语狱誉预园员圆缘跃阅云运韵灾赞脏责则泽贼赠战账赵针侦诊镇阵争证织纸质种众轴皱昼猪诸烛筑驻专转赚庄装壮资总纵组钻'

describe('字典结构', () => {
  const baseKeys = Object.keys(DICTIONARIES['zh-CN']).sort()

  it('三种语言的键集完全一致', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale]).sort(), locale).toEqual(baseKeys)
    }
  })

  it('每个键的占位符集合在各语言中一致', () => {
    const problems: string[] = []
    for (const key of baseKeys) {
      const expected = placeholders(key)
      for (const locale of LOCALES) {
        const actual = placeholders(DICTIONARIES[locale][key] ?? '')
        if (actual !== expected) problems.push(`${locale}: ${key} (${actual} != ${expected})`)
      }
    }
    expect(problems).toEqual([])
  })

  it('英文译文不含中文（语言本名除外）', () => {
    const bad = baseKeys.filter((key) => {
      const value = DICTIONARIES.en[key] ?? ''
      return CJK.test(value) && !ENDONYMS.has(key)
    })
    expect(bad).toEqual([])
  })

  it('繁体译文不含高频简体字（语言本名除外）', () => {
    const bad = baseKeys.filter((key) => {
      if (ENDONYMS.has(key)) return false
      const value = DICTIONARIES['zh-TW'][key] ?? ''
      return [...value].some((char) => SIMPLIFIED_ONLY.includes(char))
    })
    expect(bad).toEqual([])
  })
})

describe('translate', () => {
  it('按语言查表并插值', () => {
    expect(translate('zh-CN', '关闭')).toBe('关闭')
    expect(translate('en', '关闭')).toBe('Close')
    expect(translate('zh-TW', '关闭')).toBe('關閉')
    expect(translate('en', '{count} 个键', { count: 3 })).toBe('3 keys')
  })

  it('缺少参数时保留占位符', () => {
    expect(translate('en', '{count} 个键')).toBe('{count} keys')
    expect(translate('en', '{count} 个键', { count: 0 })).toBe('0 keys')
  })

  it('未知键回退到原文，不返回空串', () => {
    expect(translate('en', '这是一条还没翻译的文案')).toBe('这是一条还没翻译的文案')
  })
})

describe('语言识别', () => {
  it('isLocale / normalizeLocale', () => {
    expect(isLocale('zh-TW')).toBe(true)
    expect(isLocale('ja')).toBe(false)
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('ja')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
  })

  it('按系统语言选择：简中 / 繁中 / 其他回英文', () => {
    expect(detectLocale('zh-CN')).toBe('zh-CN')
    expect(detectLocale('zh-Hans')).toBe('zh-CN')
    expect(detectLocale('zh-TW')).toBe('zh-TW')
    expect(detectLocale('zh-Hant-HK')).toBe('zh-TW')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('ja-JP')).toBe('en')
    expect(detectLocale(undefined)).toBe('zh-CN')
  })

  it('语言菜单用各语言本名', () => {
    expect(LOCALE_NAMES).toEqual({
      'zh-CN': '简体中文',
      'zh-TW': '繁體中文',
      en: 'English',
    })
  })
})