// A small, conservative command classifier. Its only job is to pick which buttons the
// approval card offers and which plain-language warning it shows. It never approves
// anything. Python owns the full classifier (reactor_explain_risk); anything this file
// cannot positively identify as read-only is "unknown", and unknown is treated as risky.
//
// Levels:
//   safe         one plain read-only command with no shell tricks
//   unknown      could not be verified (default)
//   destructive  matches a known dangerous pattern

const MAX_COMMAND_CHARS = 2000

// Anything that lets a shell run, chain, redirect or expand something else.
const SHELL_META = /[;&|<>`$(){}\n\r\\*?~!#%^]/

// Paths that may hold secrets: even a "read-only" cat of these is not safe to wave through.
const SECRET_PATH = /(\.env|auth\.json|\.ssh|id_rsa|id_ed25519|credentials|secret|token|\.aws|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.kube|\.docker|keychain|\.gnupg|passwd|shadow)/i

const SAFE_ARG = /^[A-Za-z0-9_./:@+=,-]+$/

const SAFE_PROGRAMS = new Set(['ls', 'dir', 'pwd', 'whoami', 'uname', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'which'])
// Programs that must be called with no arguments at all (their arguments can change the system).
const BARE_ONLY = new Set(['hostname', 'date'])
// These write a file or change the system through an argument (`tree -o f`, `file -C`, `uniq in out`), so they are
// read-only only with the flags listed here: single letters (may be clustered), long names (exact, no abbreviations),
// the letters that take a number, and how many positional arguments are allowed. Keep in step with _FLAG_RULES in
// reactor_hermes/risk.py; tests/shared/risk-vectors.json runs one list through both.
const FLAG_RULES = {
  tree: {
    letters: 'adfilghpsuDFNQrtxnC',
    longs: ['--dirsfirst', '--noreport', '--prune', '--du', '--si', '--inodes', '--device', '--nolinks', '--ignore-case', '--filesfirst', '--gitignore'],
    numeric: 'L',
    positional: 99
  },
  file: {
    letters: 'bikLhnNprszE',
    longs: ['--brief', '--mime', '--mime-type', '--mime-encoding', '--keep-going', '--dereference', '--no-dereference', '--no-pad', '--preserve-date', '--raw', '--special-files', '--uncompress'],
    numeric: '',
    positional: 99
  },
  uniq: { letters: 'cdDiu', longs: [], numeric: '', positional: 1 } // a second positional argument is the OUTPUT file
}

function flagsOk(rule, args) {
  let positional = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      positional += args.length - i - 1
      break
    }
    if (a.startsWith('--')) {
      if (!rule.longs.includes(a)) return false
    } else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]
        if (rule.numeric.includes(ch)) {
          const rest = a.slice(k + 1)
          if (rest) {
            if (!/^\d+$/.test(rest)) return false
          } else if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
            i++
          } else {
            return false
          }
          break
        }
        if (!rule.letters.includes(ch)) return false
      }
    } else {
      positional++
    }
  }
  return positional <= rule.positional
}

// What `git` may be asked, as read-only, with these subcommands. Same list as Python's _GIT_READ.
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'remote', 'branch', 'tag', 'stash'])
const GIT_BAD_LONG = ['--output', '--ext-diff', '--textconv', '--no-index', '--exec', '--open-files', '--upload-pack', '--receive-pack', '--force', '--delete', '--move', '--copy', '--set-upstream', '--unset-upstream', '--edit-description']
const GIT_BRANCH_OK = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current', '--verbose', '-l'])

/** A dangerous git option, also in git's abbreviated spelling (`--out=x` is `--output=x`). */
function gitBadArg(arg) {
  if (arg === '-o' || arg === '-f') return true
  if (!arg.startsWith('--')) return false
  const name = arg.split('=')[0]
  return name.length >= 3 && GIT_BAD_LONG.some(bad => bad.startsWith(name))
}

/** `arg` is one of the long options, or an abbreviation of one (3 characters or more, as git accepts). */
function isLong(arg, ...longs) {
  if (!arg.startsWith('--')) return false
  const name = arg.split('=')[0]
  return name.length >= 3 && longs.some(l => l.startsWith(name))
}

/** A short-option cluster such as `-vd` that has one of `letters`. */
function hasShort(arg, letters) {
  return /^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].some(ch => letters.includes(ch))
}

const DESTRUCTIVE = [
  ['delete', /(^|[\s;&|(])(rm|rmdir|unlink|shred|srm)(\s|$)/i],
  ['delete', /(^|[\s;&|(])(del|erase|rd)(\s+\/[a-z]|\s+\S*\s*\/[sq])/i],
  ['delete', /\bremove-item\b/i],
  ['delete', /\bfind\b[^\n]*\s-delete\b/i],
  ['delete', /\btruncate\b/i],
  ['git-rewrite', /\bgit\b[^\n]*\b(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+(--\s+)?\.(\s|$)|restore\s+(--source|\.(\s|$))|filter-branch|filter-repo|reflog\s+(expire|delete)|gc\s+--prune|update-ref\s+-d|stash\s+(drop|clear))/i],
  ['git-rewrite', /\bgit\b[^\n]*\bpush\b[^\n]*(--force|--force-with-lease|\s-f\b|--delete|\s:[^\s]+)/i],
  ['git-rewrite', /\bgit\b[^\n]*\bbranch\b[^\n]*\s-D\b/],
  ['git-rewrite', /\bgit\b[^\n]*\brebase\b/i],
  ['privileges', /(^|[\s;&|(])(sudo|doas|su|runas)(\s|$)/i],
  ['privileges', /\b(chmod|chown|chgrp|icacls|takeown|setfacl)\b/i],
  ['remote-code', /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/i],
  ['remote-code', /\b(iex|invoke-expression)\b/i],
  ['remote-code', /\|\s*(sudo\s+)?(ba|z|da|fi)?sh(\s|$)/i],
  ['inline-shell', /(^|[\s;&|(])(bash|sh|zsh|powershell|pwsh|cmd)(\.exe)?\s+[^\n]*(-c|-command|-encodedcommand|\/c)(\s|$)/i],
  ['disk', /\b(mkfs(\.\w+)?|fdisk|parted|diskpart)\b/i],
  ['disk', /(^|[\s;&|(])format(\.com)?\s+[a-z]:/i],
  ['disk', /(^|[\s;&|(])dd\s+[^\n]*\b(if|of)=/i],
  ['disk', />\s*\/dev\/(sd|nvme|hd|disk|mem)/i],
  ['process', /\b(kill\s+-9|killall|pkill|taskkill|shutdown|reboot|halt|poweroff|stop-process|stop-computer|restart-computer)\b/i],
  ['database', /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/i],
  ['publish', /\b(npm\s+(publish|unpublish|deprecate)|pip\s+uninstall|twine\s+upload|cargo\s+(publish|yank)|gh\s+(release|repo)\s+(delete|create))\b/i],
  ['registry', /\b(reg\s+(add|delete|import)|regedit|set-itemproperty)\b/i],
  ['delete', /:\(\)\s*\{/]
]

/** Split a command line into tokens, honouring simple quotes. Returns null when unbalanced. */
export function tokenize(command) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) return null
  if (started || current) tokens.push(current)
  return tokens
}

function isSafeReadOnly(command) {
  if (SHELL_META.test(command)) return false
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0 || tokens.length > 12) return false
  const [program, ...args] = tokens
  const name = program.toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false

  if (BARE_ONLY.has(name)) return args.length === 0

  if (name === 'git') {
    const [sub, ...rest] = args
    if (!SAFE_GIT.has(sub)) return false
    if (!rest.every(arg => SAFE_ARG.test(arg) && !gitBadArg(arg) && !SECRET_PATH.test(arg))) return false
    // Whitelists, exact spelling: a branch, tag or stash is read-only only when it lists.
    if (sub === 'branch') return rest.every(arg => GIT_BRANCH_OK.has(arg))
    if (sub === 'tag') return rest.every(arg => arg === '-l' || arg === '--list')
    if (sub === 'remote') return rest.every(arg => arg === '-v' || arg === '--verbose')
    if (sub === 'stash') return rest.length === 1 && rest[0] === 'list'
    return true
  }

  if (Object.hasOwn(FLAG_RULES, name)) {
    return args.every(arg => SAFE_ARG.test(arg) && !SECRET_PATH.test(arg)) && flagsOk(FLAG_RULES[name], args)
  }

  if (!SAFE_PROGRAMS.has(name)) return false
  // cmd.exe builtins (dir) read a comma or equals sign as a separator, so the Python classifier refuses them: so do we.
  if (name === 'dir' && args.some(arg => /[,=]/.test(arg))) return false
  return args.every(arg => SAFE_ARG.test(arg) && !SECRET_PATH.test(arg))
}

/**
 * Deleting or rewriting with git, read from the words (the patterns above cannot see `-vd`, `--del` or `--forc`).
 * @returns {boolean}
 */
function gitDestructive(text) {
  for (const segment of text.split(/[;&|\n\r]+/)) {
    const tokens = tokenize(segment)
    if (!tokens) continue
    const at = tokens.findIndex(tok => /(^|[\\/])git(\.exe)?$/i.test(tok))
    if (at === -1) continue
    let i = at + 1
    while (i < tokens.length && tokens[i].startsWith('-')) i += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(tokens[i]) ? 2 : 1
    const sub = (tokens[i] || '').toLowerCase()
    const rest = tokens.slice(i + 1)
    const plain = rest.filter(arg => !arg.startsWith('-'))
    if ((sub === 'branch' || sub === 'tag') && rest.some(arg => hasShort(arg, 'dDf') || isLong(arg, '--delete', '--force'))) return true
    if (sub === 'push' && (rest.some(arg => hasShort(arg, 'fd') || isLong(arg, '--force', '--force-with-lease', '--force-if-includes', '--delete', '--mirror')) || plain.some(arg => arg.startsWith('+') || arg.startsWith(':')))) return true
  }
  return false
}

/**
 * Classify a command string.
 * @returns {{ level: 'safe' | 'unknown' | 'destructive', tags: string[] }}
 */
export function classifyCommand(command) {
  if (typeof command !== 'string') return { level: 'unknown', tags: [] }
  const text = command.trim()
  if (!text || text.length > MAX_COMMAND_CHARS || text.includes('\u0000')) {
    return { level: 'unknown', tags: [] }
  }

  const tags = []
  for (const [tag, pattern] of DESTRUCTIVE) {
    if (pattern.test(text) && !tags.includes(tag)) tags.push(tag)
  }
  if (gitDestructive(text) && !tags.includes('git-rewrite')) tags.push('git-rewrite')
  if (tags.length > 0) return { level: 'destructive', tags }

  if (isSafeReadOnly(text)) return { level: 'safe', tags: [] }
  return { level: 'unknown', tags: [] }
}

/** Anything that is not positively safe is risky. */
export function isRisky(classification) {
  return !classification || classification.level !== 'safe'
}
