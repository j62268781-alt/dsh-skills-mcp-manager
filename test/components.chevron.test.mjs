/** components/chevron 接口测试：展开态属性与图标结构。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { Chevron } from '../lib/src/components/chevron.jsx'

globalThis.__dshReact = React

test('Chevron：className 与 data-open 跟随 open', () => {
  const open = Chevron({ open: true })
  assert.equal(open.type, 'svg')
  assert.equal(open.props.className, 'smp-chevron')
  assert.equal(open.props['data-open'], 'true')
  assert.equal(Chevron({ open: false }).props['data-open'], 'false')
})

test('Chevron：内部是圆角折线 path', () => {
  const path = React.Children.toArray(Chevron({ open: false }).props.children)[0]
  assert.equal(path.type, 'path')
  assert.equal(path.props.d, 'M4 6l4 4 4-4')
  assert.equal(path.props.stroke, 'currentColor')
})
