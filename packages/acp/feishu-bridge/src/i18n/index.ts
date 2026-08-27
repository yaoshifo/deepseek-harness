/**
 * i18n runtime: language detection, resolution, and message lookup with the
 * Go fallback chain, ported from cc-connect core/i18n/i18n.go. Translation
 * tables and key constants are generated siblings (./messages.ts,
 * ./keys.ts).
 *
 * @module dsh-feishu-bridge/i18n
 */

import { sprintf } from '../sprintf.js'
import type { MsgKey } from './keys.js'
import { messages } from './messages.js'

export { ALL_MSG_KEYS } from './keys.js'
export * from './keys.js'
export { messages } from './messages.js'
export type { LocaleCode } from './messages.js'

/**
 * Supported language. Open like the Go `type Language string`: config and
 * detection feed arbitrary codes; the closed locale set the tables actually
 * carry is {@link LocaleCode}, and lookups fall back for anything else.
 */
export type Language = '' | 'en' | 'zh' | 'zh-TW' | 'ja' | 'es' | (string & {})

/** Auto-detect from user messages. */
export const langAuto: Language = ''
/** English. */
export const langEnglish: Language = 'en'
/** Simplified Chinese. */
export const langChinese: Language = 'zh'
/** Traditional Chinese. */
export const langTraditionalChinese: Language = 'zh-TW'
/** Japanese. */
export const langJapanese: Language = 'ja'
/** Spanish. */
export const langSpanish: Language = 'es'

/**
 * Whether `ch` is a Chinese ideograph (CJK Unified Ideographs and
 * extensions).
 * @param ch - Single character (one code point).
 * @returns True for Chinese ideographs.
 */
export function isChinese(ch: string): boolean {
  const r = ch.codePointAt(0) ?? 0
  return (r >= 0x4E00 && r <= 0x9FFF) ||
    (r >= 0x3400 && r <= 0x4DBF) ||
    (r >= 0x20000 && r <= 0x2A6DF) ||
    (r >= 0x2A700 && r <= 0x2B73F) ||
    (r >= 0x2B740 && r <= 0x2B81F) ||
    (r >= 0x2B820 && r <= 0x2CEAF) ||
    (r >= 0xF900 && r <= 0xFAFF) ||
    (r >= 0x2F800 && r <= 0x2FA1F)
}

/**
 * Whether `ch` is a Japanese kana (hiragana, katakana, katakana phonetic
 * extensions, half-width katakana).
 * @param ch - Single character (one code point).
 * @returns True for kana.
 */
export function isJapanese(ch: string): boolean {
  const r = ch.codePointAt(0) ?? 0
  return (r >= 0x3040 && r <= 0x309F) || // Hiragana
    (r >= 0x30A0 && r <= 0x30FF) || // Katakana
    (r >= 0x31F0 && r <= 0x31FF) || // Katakana Phonetic Extensions
    (r >= 0xFF65 && r <= 0xFF9F) // Half-width Katakana
}

/** Whether the text contains characters common in Spanish but not English (ñ, ¿, ¡, accented vowels). */
const isSpanishHint = (text: string): boolean => {
  for (const r of text) {
    switch (r) {
      case 'ñ': case 'Ñ': case '¿': case '¡':
      case 'á': case 'é': case 'í': case 'ó': case 'ú': case 'ü':
        return true
    }
  }
  return false
}

/**
 * Detect the language of a user message: Japanese kana first, then Chinese
 * ideographs, then Spanish hints, defaulting to English.
 * @param text - User message text.
 * @returns The detected language.
 */
export function detectLanguage(text: string): Language {
  for (const r of text) {
    if (isJapanese(r)) {
      return langJapanese
    }
  }
  for (const r of text) {
    if (isChinese(r)) {
      return langChinese
    }
  }
  if (isSpanishHint(text)) {
    return langSpanish
  }
  return langEnglish
}

/**
 * Whether the text contains enough English words to be a deliberate English
 * message (as opposed to a short command like "/provider"): 3+ separators
 * means at least 4 words.
 */
const hasClearEnglishSignal = (text: string): boolean => {
  let wordCount = 0
  for (const r of text) {
    if (r === ' ' || r === '\t' || r === '\n') {
      wordCount++
    }
  }
  return wordCount >= 3
}

/**
 * One table's step of the Go fallback chain: current language → Simplified
 * Chinese for Traditional Chinese → English.
 * @param table - The per-key language map to read.
 * @param lang - Language to look up.
 * @returns The translated message, or undefined when the table misses.
 */
function lookupInTable(table: Partial<Record<string, string>> | undefined, lang: Language): string | undefined {
  if (table === undefined) return undefined
  const translated = table[lang]
  if (translated !== undefined) {
    return translated
  }
  if (lang === langTraditionalChinese) {
    const zh = table[langChinese]
    if (zh !== undefined) {
      return zh
    }
  }
  const en = table[langEnglish]
  if (en !== undefined && en !== '') {
    return en
  }
  return undefined
}

/**
 * Message-table lookup with the fallback chain ported from Go: current
 * language → Simplified Chinese for Traditional Chinese → English → the raw
 * key. The main table is consulted first, then every registered subtable
 * ({@link registerMessages}); shared by {@link I18n.t} and
 * {@link lookupMessage}.
 *
 * @param lang - Language to look up.
 * @param key - Message key.
 * @returns The translated message, or the raw key when missing.
 */
function resolveMessage(lang: Language, key: MsgKey | (string & {})): string {
  // Open lookup: keys can arrive cast from arbitrary strings (Go's MsgKey
  // was an open string type), so a miss must fall through, not throw.
  const main = lookupInTable((messages as Record<string, Partial<Record<string, string>> | undefined>)[key], lang)
  if (main !== undefined) return main
  for (const subtable of messageSubtables()) {
    const translated = lookupInTable(subtable.byKey[key], lang)
    if (translated !== undefined) return translated
  }
  return key
}

/** One live subtable registration: the source object plus its transposed per-key view. */
interface MessageSubtableRegistration {
  /** The caller's object; identity keys the reference counting. */
  source: Partial<Record<Language, Record<string, string>>>
  /** The same messages transposed to the main table's per-key language maps. */
  byKey: Record<string, Partial<Record<string, string>>>
}

/**
 * Live subtable registrations (see {@link registerMessages}); the same
 * subtable object may appear several times (reference-counted reloads).
 */
const subtableRegistrations: MessageSubtableRegistration[] = []

/** The registered subtables, one entry per distinct source object, in registration order. */
function messageSubtables(): MessageSubtableRegistration[] {
  const seen = new Set<Partial<Record<Language, Record<string, string>>>>()
  const unique: MessageSubtableRegistration[] = []
  for (const registration of subtableRegistrations) {
    if (seen.has(registration.source)) continue
    seen.add(registration.source)
    unique.push(registration)
  }
  return unique
}

/** Transpose a per-language subtable into the main table's per-key shape. */
function transposeSubtable(subtable: Partial<Record<Language, Record<string, string>>>): Record<string, Partial<Record<string, string>>> {
  const byKey: Record<string, Partial<Record<string, string>>> = {}
  for (const [lang, langMessages] of Object.entries(subtable)) {
    for (const [key, value] of Object.entries(langMessages ?? {})) {
      (byKey[key] ??= {})[lang] = value
    }
  }
  return byKey
}

/**
 * Register a module-level message subtable sibling plugins own (the chatroom
 * package's keys): `resolveMessage` consults the main table first, then every
 * registered subtable, same fallback chain. Registration is reference-counted
 * per object (an HMR reload re-runs apply before the old fiber's disposer
 * drains), while a DIFFERENT object re-registering an existing key throws —
 * two owners for one key is a conflict, not a reload.
 *
 * @param subtable - Per-language message maps; a key already in the main
 *   table or another registered subtable throws.
 * @returns Disposer removing one registration of the subtable.
 */
export function registerMessages(subtable: Partial<Record<Language, Record<string, string>>>): () => void {
  const byKey = transposeSubtable(subtable)
  for (const key of Object.keys(byKey)) {
    if (key in (messages as Record<string, unknown>)) {
      throw new Error(`i18n: subtable key '${key}' collides with the main message table`)
    }
    for (const registered of messageSubtables()) {
      if (registered.source === subtable) continue
      if (key in registered.byKey) {
        throw new Error(`i18n: subtable key '${key}' is already registered by another subtable`)
      }
    }
  }
  subtableRegistrations.push({ source: subtable, byKey })
  return () => {
    const index = subtableRegistrations.findIndex(registration => registration.source === subtable)
    if (index < 0) return
    subtableRegistrations.splice(index, 1)
  }
}

/**
 * Look up a message for an explicit language, for consumers that hold the
 * resolved language instead of the {@link I18n} instance (e.g. the extracted
 * chatroom package). Same fallback chain as `I18n.t`; Go-style format verbs
 * are substituted when `args` are given, matching `I18n.tf`.
 *
 * @param lang - Language to look up; unknown codes fall back to English.
 * @param key - Message key; a miss returns the raw key. Open lookup: keys
 *   beyond {@link MsgKey} (subtable keys) are looked up the same way.
 * @param args - Optional format arguments for Go-style verbs (%s, %d, …).
 * @returns The translated (and formatted) message.
 */
export function lookupMessage(lang: Language, key: MsgKey | (string & {}), ...args: unknown[]): string {
  return sprintf(resolveMessage(lang, key), ...args)
}

/**
 * Internationalized message lookup for one bridge instance.
 */
export class I18n {
  private lang: Language
  private detected: Language = ''
  private saveFunc: ((lang: Language) => void) | undefined

  /**
   * @param lang - Fixed language, or {@link langAuto} to detect from messages.
   */
  constructor(lang: Language) {
    this.lang = lang
  }

  /**
   * Register the persistence callback invoked when auto-detection changes
   * the resolved language (Go's SetSaveFunc; a throwing callback is warned
   * and swallowed, matching the Go error-return + slog.Warn shape).
   * @param fn - Callback receiving the newly detected language.
   */
  setSaveFunc(fn: (lang: Language) => void): void {
    this.saveFunc = fn
  }

  /**
   * Auto-detect the language from a message. Only acts in auto mode, and a
   * short/command message (no clear English signal) never overrides an
   * already-detected language — "/provider" is ASCII-only and would reset
   * to English.
   * @param text - Incoming user message.
   */
  detectAndSet(text: string): void {
    if (this.lang !== langAuto) {
      return
    }
    const detected = detectLanguage(text)
    if (this.detected !== '' && detected === langEnglish && !hasClearEnglishSignal(text)) {
      return
    }
    if (this.detected !== detected) {
      this.detected = detected
      if (this.saveFunc !== undefined) {
        try {
          this.saveFunc(detected)
        } catch (err) {
          console.warn('failed to save language', err)
        }
      }
    }
  }

  /**
   * The resolved language: fixed value, last detection, or English before any detection.
   *
   * @returns The language used for message lookups.
   */
  currentLang(): Language {
    if (this.lang === langAuto) {
      if (this.detected !== '') {
        return this.detected
      }
      return langEnglish
    }
    return this.lang
  }

  /**
   * True for Simplified and Traditional Chinese.
   *
   * @returns True when the resolved language is a Chinese variant.
   */
  isZhLike(): boolean {
    const l = this.currentLang()
    return l === langChinese || l === langTraditionalChinese
  }

  /**
   * Override the language (disabling auto-detect).
   * @param lang - Language to pin.
   */
  setLang(lang: Language): void {
    this.lang = lang
    this.detected = ''
  }

  /**
   * Look up a message. Fallback chain: current language → Simplified Chinese
   * for Traditional Chinese → English → the raw key.
   * @param key - Message key; open lookup — keys beyond {@link MsgKey}
   *   (registered subtable keys) resolve the same way.
   * @returns The translated message.
   */
  t(key: MsgKey | (string & {})): string {
    return resolveMessage(this.currentLang(), key)
  }

  /**
   * Look up a message and substitute Go-style format verbs with `args`.
   * @param key - Message key; open lookup as in {@link I18n.t}.
   * @param args - Format arguments.
   * @returns The formatted message.
   */
  tf(key: MsgKey | (string & {}), ...args: unknown[]): string {
    return sprintf(this.t(key), ...args)
  }
}
