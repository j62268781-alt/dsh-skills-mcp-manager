/**
 * 弹出菜单贴哪儿：视口坐标 + 向上还是向下。
 *
 * ## 为什么需要它
 *
 * 菜单原来是 `position: absolute; top: calc(100% + 4px); right: 0` —— 永远向下展开，
 * 而且定位祖先是卡片里那个 `position: relative` 的小容器。两个后果：
 *
 *   · 卡片靠近可视区底部时，菜单下半截被**视口**切掉；
 *   · 面板自己的滚动容器有 `overflow`，绝对定位的后代会被它**裁剪**，滚到哪儿都看不全。
 *
 * 所以改成 `position: fixed`：视口坐标不受任何祖先的 overflow 影响，同时让我们能自己
 * 决定往上还是往下。
 *
 * ## 判定规则
 *
 * 优先向下（和触发按钮的阅读顺序一致，也符合「点开的东西出现在点的下方」的直觉）；
 * 下方放不下、而上方的空间更宽裕时翻转向上；两边都放不下时选**空间更大**的那边，
 * 由 CSS 的 `max-height` 让菜单自己滚动，而不是被切掉。
 *
 * 只有「量不出来」时返回 null —— 调用方退回原来的绝对定位。测试渲染器没有真实布局，
 * 这里必须能安静地降级，而不是让整个面板崩掉。
 */

/** 一项菜单的大致高度：上下 padding 6+6 加一行 18 的文字。 */
const ITEM_HEIGHT_PX = 30
/** 容器自身的 padding 4+4 与边框。 */
const CHROME_HEIGHT_PX = 10
/** 与视口边缘之间至少留这么多，避免菜单贴死边框。 */
const EDGE_PX = 8
/** 菜单与触发按钮之间的缝。 */
const GAP_PX = 4

/**
 * 算出一份菜单该贴在哪。
 *
 * @param options.rect - 触发按钮的 `getBoundingClientRect()` 结果（或形状相同的对象）。
 * @param options.itemCount - 菜单项数量，用来估高度。
 * @param options.viewportWidth - 视口宽。
 * @param options.viewportHeight - 视口高。
 * @returns `{ right, top, bottom, placement: 'down'|'up', maxHeight }`，量不出来时 null。
 */
export function measureMenuAnchor({ rect, itemCount, viewportWidth, viewportHeight } = {}) {
  if (rect === undefined || rect === null) return null
  const top = Number(rect.top)
  const bottom = Number(rect.bottom)
  const right = Number(rect.right)
  const width = Number(viewportWidth)
  const height = Number(viewportHeight)
  if (![top, bottom, right, width, height].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0) return null

  const estimated = Math.max(0, Number(itemCount) || 0) * ITEM_HEIGHT_PX + CHROME_HEIGHT_PX
  const spaceBelow = height - bottom - EDGE_PX
  const spaceAbove = top - EDGE_PX
  // 向下放得下就用向下；否则上方更宽裕就向上；两边都不够时选空间大的那边。
  const placement = spaceBelow >= estimated || spaceBelow >= spaceAbove ? 'down' : 'up'

  return {
    // 右对齐到触发按钮：菜单在按钮左下方展开，是这一列操作的常见位置。
    right: Math.max(EDGE_PX, width - right),
    top: Math.round(bottom + GAP_PX),
    bottom: Math.round(height - top + GAP_PX),
    placement,
    // 两边都不够时，让菜单自己滚动而不是被切掉。
    maxHeight: Math.max(0, (placement === 'up' ? spaceAbove : spaceBelow)),
  }
}

/**
 * 把锚点转成 React 的内联样式。
 *
 * 分开成函数是为了让「量出来的锚点」和「写进 DOM 的样式」之间没有隐含约定 ——
 * 上下两个方向用的是**互斥**的一对定位属性，写错一个方向就是菜单跑到屏幕外。
 *
 * @param anchor - {@link measureMenuAnchor} 的返回值。
 * @returns 内联样式对象；anchor 为 null 时返回 undefined（走 CSS 默认）。
 */
export function anchorStyle(anchor) {
  if (anchor === null || anchor === undefined) return undefined
  const style = {
    position: 'fixed',
    right: `${String(anchor.right)}px`,
    maxHeight: `${String(anchor.maxHeight)}px`,
    overflowY: 'auto',
  }
  if (anchor.placement === 'up') {
    style.bottom = `${String(anchor.bottom)}px`
    style.top = 'auto'
  } else {
    style.top = `${String(anchor.top)}px`
    style.bottom = 'auto'
  }
  return style
}
