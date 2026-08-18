#!/usr/bin/env node
/**
 * One-off generator: parses cc-connect core/i18n/i18n.go (read-only source)
 * and emits src/i18n/keys.ts + src/i18n/messages.ts for dsh-feishu-bridge.
 * Re-run only when the upstream table changes.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = '/home/hm/workspace/cc-connect/core/i18n/i18n.go'
const OUT_KEYS = 'packages/acp/feishu-bridge/src/i18n/keys.ts'
const OUT_MSGS = 'packages/acp/feishu-bridge/src/i18n/messages.ts'

const src = readFileSync(SRC, 'utf8')

function goUnescape(lit) {
  // lit: contents of a Go interpreted string literal (no quotes)
  let out = ''
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i]
    if (c !== '\\') { out += c; continue }
    const n = lit[++i]
    switch (n) {
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case "'": out += "'"; break
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case 'a': out += '\x07'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'v': out += '\v'; break
      case 'x': out += String.fromCharCode(parseInt(lit.slice(i + 1, i + 3), 16)); i += 2; break
      case 'u': out += String.fromCharCode(parseInt(lit.slice(i + 1, i + 5), 16)); i += 4; break
      case 'U': out += String.fromCodePoint(parseInt(lit.slice(i + 1, i + 9), 16)); i += 8; break
      default:
        if (n >= '0' && n <= '7') { out += String.fromCharCode(parseInt(lit.slice(i, i + 3), 8)); i += 2; break }
        throw new Error(`unknown escape \\${n}`)
    }
  }
  return out
}

function tsEscape(s) {
  return "'" + s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\x00-\x1f]/g, ch => {
      const c = ch.charCodeAt(0)
      if (ch === '\n') return '\\n'
      if (ch === '\r') return '\\r'
      if (ch === '\t') return '\\t'
      return '\\u' + c.toString(16).padStart(4, '0')
    }) + "'"
}

// 1. MsgKey constants (declaration order).
const constRe = /^\t(Msg\w+)\s+MsgKey\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:\/\/.*)?$/gm
const consts = []
let m
while ((m = constRe.exec(src)) !== null) {
  consts.push({ name: m[1], value: goUnescape(m[2]) })
}
if (consts.length === 0) throw new Error('no MsgKey constants parsed')

// 2. messages map entries.
const start = src.indexOf('var messages = map[MsgKey]map[Language]string{')
const end = src.indexOf('func (i *I18n) T')
const block = src.slice(start, end)
const entryRe = /\n\t(Msg\w+): \{\n([\s\S]*?)\n\t\},?/g
const LANG = { LangEnglish: 'en', LangChinese: 'zh', LangTraditionalChinese: 'zh-TW', LangJapanese: 'ja', LangSpanish: 'es' }
const entries = []
while ((m = entryRe.exec(block)) !== null) {
  // Merge Go string-literal concatenations: a line ending in `+` continues
  // on the next line (continuation lines are indented with 3 tabs).
  const rawLines = m[2].split('\n')
  const logical = []
  for (const line of rawLines) {
    const trimmed = line.replace(/^\t\t\t/, '\t\t')
    if (logical.length > 0 && logical[logical.length - 1].endsWith('+')) {
      logical[logical.length - 1] += ' ' + trimmed
    } else {
      logical.push(trimmed)
    }
  }
  const langs = {}
  for (const line of logical) {
    if (!/^\t\tLang\w+:/.test(line)) throw new Error(`unparsed lang line: ${JSON.stringify(line)}`)
    // A logical line may carry several `LangX: "..." [,+] LangY: "..."` pairs;
    // slice each token's value as the span up to the next Lang token. String
    // literals are masked before scanning so translations mentioning
    // "Language: ..." inside quotes cannot pose as tokens (positions keep).
    const masked = line.replace(/"(?:[^"\\]|\\.)*"/g, s => ' '.repeat(s.length))
    const tokens = [...masked.matchAll(/Lang\w+:/g)]
    if (tokens.length === 0) throw new Error(`no lang tokens in: ${JSON.stringify(line)}`)
    for (let t = 0; t < tokens.length; t++) {
      const code = LANG[tokens[t][0].slice(0, -1)]
      if (code === undefined) throw new Error(`unknown lang const ${tokens[t][0]}`)
      const from = tokens[t].index + tokens[t][0].length
      const to = t + 1 < tokens.length ? tokens[t + 1].index : line.length
      const expr = line.slice(from, to)
      const parts = [...expr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(q => goUnescape(q[1]))
      if (parts.length === 0) throw new Error(`no literals in: ${JSON.stringify(expr)}`)
      langs[code] = parts.join('')
    }
  }
  entries.push({ name: m[1], langs })
}

// 3. Validate 1:1.
const constNames = new Set(consts.map(c => c.name))
const entryNames = new Set(entries.map(e => e.name))
const missing = [...constNames].filter(n => !entryNames.has(n))
const extra = [...entryNames].filter(n => !constNames.has(n))
if (missing.length || extra.length) throw new Error(`mismatch missing=${missing} extra=${extra}`)
const noEn = entries.filter(e => e.langs.en === undefined)
const noZh = entries.filter(e => e.langs.zh === undefined)
if (noEn.length || noZh.length) throw new Error(`entries missing en=${noEn.length} zh=${noZh.length}`)

const identRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = k => (identRe.test(k) ? k : tsEscape(k).slice(1, -1).replace(/\\'/g, "'").startsWith('`') ? `'${k}'` : identRe.test(k) ? k : `'${k}'`)
const propKey = k => (identRe.test(k) ? k : `'${k}'`)

// 4. Emit keys.ts.
{
  const lines = []
  lines.push('/**')
  lines.push(' * Message keys ported 1:1 from cc-connect core/i18n/i18n.go (generated')
  lines.push(' * by the M0 port script; regenerate against that file when it changes).')
  lines.push(' *')
  lines.push(' * @module dsh-feishu-bridge/i18n-keys')
  lines.push(' */')
  lines.push('')
  lines.push('/** Every message key value, in Go declaration order. */')
  lines.push('export const ALL_MSG_KEYS = [')
  for (const c of consts) lines.push(`  ${tsEscape(c.value)},`)
  lines.push('] as const')
  lines.push('')
  lines.push('/** Message key union (all Go MsgKey constant values). */')
  lines.push('export type MsgKey = (typeof ALL_MSG_KEYS)[number]')
  lines.push('')
  for (const c of consts) {
    lines.push(`export const ${c.name}: MsgKey = ${tsEscape(c.value)}`)
  }
  lines.push('')
  writeFileSync(OUT_KEYS, lines.join('\n'))
}

// 5. Emit messages.ts.
{
  const lines = []
  lines.push('/**')
  lines.push(' * Translation tables ported 1:1 from cc-connect core/i18n/i18n.go')
  lines.push(' * (generated by the M0 port script; regenerate against that file when')
  lines.push(' * it changes). Entry and locale ordering follow the Go map literal.')
  lines.push(' *')
  lines.push(' * @module dsh-feishu-bridge/i18n-messages')
  lines.push(' */')
  lines.push('')
  lines.push("import type { MsgKey } from './keys.js'")
  lines.push('')
  lines.push('/** Closed set of locales the tables carry (subset of Language). */')
  lines.push("export type LocaleCode = 'en' | 'zh' | 'zh-TW' | 'ja' | 'es'")
  lines.push('')
  lines.push('/** Per-key locale table; every key has English and Chinese, mirroring the Go test gates. */')
  lines.push('export const messages: Record<MsgKey, Partial<Record<LocaleCode, string>>> = {')
  for (const e of entries) {
    const constValue = consts.find(c => c.name === e.name).value
    const parts = Object.entries(e.langs).map(([code, text]) => `${propKey(code)}: ${tsEscape(text)}`)
    lines.push(`  ${propKey(constValue)}: { ${parts.join(', ')} },`)
  }
  lines.push('}')
  lines.push('')
  writeFileSync(OUT_MSGS, lines.join('\n'))
}

console.log(`consts=${consts.length} entries=${entries.length}`)
console.log('locale coverage:', JSON.stringify(entries.reduce((acc, e) => {
  for (const code of Object.keys(e.langs)) acc[code] = (acc[code] ?? 0) + 1
  return acc
}, {})))
