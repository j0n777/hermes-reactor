// Maps keyed by ids that came from outside (agent ids, session ids, task ids). A plain `{}` has Object.prototype behind it, so
// an id such as `__proto__`, `constructor` or `toString` would read or replace something that is not an entry. These helpers
// build objects with no prototype at all: every key is an ordinary own key, and a missing key reads as undefined.

/** A prototype-less copy of `source` (or an empty one). Own keys only, `__proto__` included as a plain key. */
export function dict(source) {
  const out = Object.create(null)
  if (source) for (const key of Object.keys(source)) out[key] = source[key]
  return out
}

/** A new dict equal to `source` with one key set. */
export function put(source, key, value) {
  const out = dict(source)
  out[key] = value
  return out
}

/** A dict from [key, value] pairs. */
export function dictFrom(entries) {
  const out = Object.create(null)
  for (const [key, value] of entries) out[key] = value
  return out
}

/** `table[key]` only when `key` is an own key of `table`; undefined otherwise (for fixed tables looked up by outside text). */
export function ownGet(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined
}
