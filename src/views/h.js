// A tiny element helper over react/jsx-runtime. Desktop plugins load uncompiled, so there
// is no JSX here: views call h(type, props, ...children).

import { jsx, jsxs } from 'react/jsx-runtime'

export function h(type, props, ...children) {
  const { key, ...rest } = props || {}
  if (children.length === 0) return jsx(type, rest, key)
  if (children.length === 1) return jsx(type, { ...rest, children: children[0] }, key)
  return jsxs(type, { ...rest, children }, key)
}

export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}
