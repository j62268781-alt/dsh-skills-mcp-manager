/**
 * 弹出菜单的定位判定：向下还是向上、贴在哪里。
 *
 * 真机反馈：卡片靠近可视区底部时菜单**下半截看不见**。原因有两层，缺一不可地都要解决：
 *
 *   1. 菜单原先是 `position:absolute`，定位祖先是卡片里那个 `position:relative` 小容器，
 *      而面板自己的滚动容器有 `overflow` —— 绝对定位的后代会被**裁剪**；
 *   2. 它永远向下展开，没有「上方还有多少空间」这个概念。
 *
 * 所以改成视口坐标 + 主动翻转。这里钉住的是判定规则本身 —— 它是纯函数，可以脱离浏览器
 * 完整验证；而「像素看起来对不对」只能靠真机，不该混在同一个测试里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorStyle, measureMenuAnchor } from '../lib/src/components/menuAnchor.js'

const VIEWPORT = { viewportWidth: 800, viewportHeight: 600 }
/** 一个位于视口中间偏上的触发按钮。 */
const midRect = { top: 100, bottom: 122, right: 700 }

test('空间充裕时向下展开（与阅读顺序一致）', () => {
  const anchor = measureMenuAnchor({ rect: midRect, itemCount: 3, ...VIEWPORT })
  assert.equal(anchor.placement, 'down')
  // 菜单顶边贴着按钮底边 + 4px 的缝
  assert.equal(anchor.top, 126)
})

test('下方放不下、上方更宽裕时翻转向上', () => {
  /**
   * 这是用户遇到的那个场景：卡片在底部，菜单向下就被视口切掉。
   * 触发按钮底边贴近视口下沿，上方有大片空间。
   */
  const bottomRect = { top: 560, bottom: 582, right: 700 }
  const anchor = measureMenuAnchor({ rect: bottomRect, itemCount: 3, ...VIEWPORT })
  assert.equal(anchor.placement, 'up')
  // 向上时用 `bottom`（距视口底边的距离）而不是 top
  assert.equal(anchor.bottom, 600 - 560 + 4)
})

test('下方刚好放得下就不翻转（避免毫无必要的跳动）', () => {
  // 3 项 ≈ 3*30+10 = 100；按钮底边 480，下方剩 600-480-8 = 112 > 100
  const rect = { top: 458, bottom: 480, right: 700 }
  const anchor = measureMenuAnchor({ rect, itemCount: 3, ...VIEWPORT })
  assert.equal(anchor.placement, 'down')
})

test('两边都放不下时选空间更大的一边，并给出 maxHeight 让它自己滚动', () => {
  /**
   * 窄小的窗口 + 很长的菜单：无论上下都装不下。此时不能选「离得近」的那一边，
   * 而要选「更宽敞」的那一边，并让菜单在那一侧滚动 —— 被切掉一部分是最差的结果。
   */
  const tall = { viewportWidth: 800, viewportHeight: 300 }
  const rect = { top: 120, bottom: 142, right: 700 }   // 下方 150，上方 112
  const anchor = measureMenuAnchor({ rect, itemCount: 20, ...tall })
  assert.equal(anchor.placement, 'down', '下方更宽裕')
  assert.equal(anchor.maxHeight, 300 - 142 - 8)
  // maxHeight 必须是正数，否则菜单会被压没
  assert.ok(anchor.maxHeight > 0)

  const rect2 = { top: 200, bottom: 222, right: 700 }  // 下方 70，上方 192
  const anchor2 = measureMenuAnchor({ rect: rect2, itemCount: 20, ...tall })
  assert.equal(anchor2.placement, 'up')
  assert.equal(anchor2.maxHeight, 200 - 8)
})

test('菜单项越多越容易翻转（高度是按项数估的，不是写死的）', () => {
  // 同一个按钮位置：3 项向下放得下，但 10 项放不下 → 应当翻转
  const rect = { top: 440, bottom: 460, right: 700 }   // 下方 600-460-8 = 132
  assert.equal(measureMenuAnchor({ rect, itemCount: 3, ...VIEWPORT }).placement, 'down')
  assert.equal(measureMenuAnchor({ rect, itemCount: 10, ...VIEWPORT }).placement, 'up')
})

test('右对齐到触发按钮，且不会溢出视口左边缘', () => {
  const anchor = measureMenuAnchor({ rect: { top: 100, bottom: 122, right: 700 }, itemCount: 2, ...VIEWPORT })
  assert.equal(anchor.right, 100, '离右边缘 100px')
  // 按钮贴着视口右边时也必须留出 edge，不能算出负数/0
  const flush = measureMenuAnchor({ rect: { top: 100, bottom: 122, right: 800 }, itemCount: 2, ...VIEWPORT })
  assert.equal(flush.right, 8)
})

test('量不出来时返回 null，让调用方退回 CSS 默认', () => {
  /**
   * 测试渲染器没有真实布局，`getBoundingClientRect` 不存在或返回全是 0。
   * 这里必须安静地降级 —— 一个定位问题不该让整个面板崩掉。
   */
  assert.equal(measureMenuAnchor({ rect: undefined, itemCount: 3, ...VIEWPORT }), null)
  assert.equal(measureMenuAnchor({ rect: null, itemCount: 3, ...VIEWPORT }), null)
  // 视口尺寸缺失或非法
  assert.equal(measureMenuAnchor({ rect: midRect, itemCount: 3, viewportWidth: 0, viewportHeight: 600 }), null)
  assert.equal(measureMenuAnchor({ rect: midRect, itemCount: 3, viewportWidth: 800, viewportHeight: Number.NaN }), null)
  assert.equal(measureMenuAnchor({}), null)
})

test('anchorStyle：两个方向用的是互斥的一对定位属性', () => {
  /**
   * 写错方向就是菜单跑到屏幕外，而且**不会有任何报错** —— 这是这条测试存在的全部理由。
   */
  const down = anchorStyle(measureMenuAnchor({ rect: midRect, itemCount: 3, ...VIEWPORT }))
  assert.equal(down.position, 'fixed')
  assert.ok(down.top !== 'auto')
  assert.equal(down.bottom, 'auto')

  const up = anchorStyle(measureMenuAnchor({ rect: { top: 560, bottom: 582, right: 700 }, itemCount: 3, ...VIEWPORT }))
  assert.equal(up.position, 'fixed')
  assert.equal(up.top, 'auto')
  assert.ok(up.bottom !== 'auto')

  // 没有锚点时返回 undefined，交给 CSS（绝对定位的那套兜底）
  assert.equal(anchorStyle(null), undefined)
  assert.equal(anchorStyle(undefined), undefined)
})

test('anchorStyle：fixed 才能逃出祖先的 overflow 裁剪', () => {
  // 这一条是这次问题的根因之一：absolute 会被面板滚动容器裁掉。
  const style = anchorStyle(measureMenuAnchor({ rect: midRect, itemCount: 3, ...VIEWPORT }))
  assert.equal(style.position, 'fixed')
  assert.equal(style.overflowY, 'auto', '两边都放不下时要能滚动，而不是被切掉')
})
