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
export const langEnglish: Language = 'en'
export const langChinese: Language = 'zh'
export const langTraditionalChinese: Language = 'zh-TW'
export const langJapanese: Language = 'ja'
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

  /** The resolved language: fixed value, last detection, or English before any detection. */
  currentLang(): Language {
    if (this.lang === langAuto) {
      if (this.detected !== '') {
        return this.detected
      }
      return langEnglish
    }
    return this.lang
  }

  /** True for Simplified and Traditional Chinese. */
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
   * @param key - Message key.
   * @returns The translated message.
   */
  t(key: MsgKey): string {
    const lang = this.currentLang()
    // Open lookup: keys can arrive cast from arbitrary strings (Go's MsgKey
    // was an open string type), so a miss must fall through, not throw.
    const table = (messages as Record<string, Partial<Record<string, string>> | undefined>)[key]
    if (table !== undefined) {
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
    }
    return key
  }

  /**
   * Look up a message and substitute Go-style format verbs with `args`.
   * @param key - Message key.
   * @param args - Format arguments.
   * @returns The formatted message.
   */
  tf(key: MsgKey, ...args: unknown[]): string {
    return sprintf(this.t(key), ...args)
  }
}
