import { describe, expect, it } from 'vitest'
import {
  Msg,
  ALL_MSG_KEYS,
  type Language,
  type MsgKey,
  detectLanguage,
  I18n,
  isChinese,
  isJapanese,
  langChinese,
  langEnglish,
  messages,
} from '../src/i18n/index.js'

// Ported from cc-connect core/i18n/i18n_test.go (11 Go tests).
//
// Go's open `type Language string` / `type MsgKey string` accept any string;
// the TS unions are closed, so the fallback-coverage tests cast their
// deliberately-invalid literals.

describe('I18n', () => {
  it('DefaultLanguage', () => {
    const i = new I18n(langEnglish)
    expect(i.t(Msg.Starting)).not.toBe('')
  })

  it('Chinese', () => {
    const i = new I18n(langChinese)
    const got = i.t(Msg.Starting)
    expect(got).not.toBe('')
    // Should contain Chinese characters, not English
    expect(got).not.toBe('⏳ Processing...')
  })

  it('FallbackToEnglish', () => {
    // Language is an open union (Go's `type Language string`), so no cast needed.
    const i = new I18n('nonexistent')
    expect(i.t(Msg.Starting)).not.toBe('')
  })

  it('MissingKey', () => {
    const i = new I18n(langEnglish)
    // Go's T returns the raw key for missing entries; the Go test only
    // logged (never failed) on other outcomes.
    expect(i.t('totally_missing_key' as MsgKey)).toBe('totally_missing_key')
  })

  it('Tf', () => {
    const i = new I18n(langEnglish)
    expect(i.tf(Msg.NameSet, 'myname', 'abc123')).not.toBe('')
  })

  it('AllKeysHaveEnglish', () => {
    for (const [key, langs] of Object.entries(messages)) {
      expect(langs.en, `message key ${key} missing English translation`).toBeDefined()
    }
  })

  it('AllKeysHaveChinese', () => {
    for (const [key, langs] of Object.entries(messages)) {
      expect(langs.zh, `message key ${key} missing Chinese translation`).toBeDefined()
    }
  })

  it('AllConstantsHaveTranslations', () => {
    // Go parsed the source for MsgKey constants; here the generated
    // ALL_MSG_KEYS list is the same inventory.
    for (const key of ALL_MSG_KEYS) {
      expect(messages[key], `MsgKey constant ${key} has no translation entry`).toBeDefined()
    }
  })
})

describe('detectLanguage', () => {
  it('classifies by script', () => {
    const cases: [string, Language][] = [
      // Japanese Hiragana
      ['こんにちは', 'ja'],
      ['あいうえお', 'ja'],
      // Japanese Katakana
      ['カタカナ', 'ja'],
      // Chinese
      ['你好', 'zh'],
      ['中文测试', 'zh'],
      // Spanish
      ['¿Cómo estás?', 'es'],
      ['Niño español', 'es'],
      ['¡Hola!', 'es'],
      // English (default)
      ['Hello world', 'en'],
      ['Just normal text', 'en'],
      ['', 'en'],
    ]
    for (const [text, want] of cases) {
      expect(detectLanguage(text), `detectLanguage(${JSON.stringify(text)})`).toBe(want)
    }
  })
})

describe('isChinese', () => {
  it('detects CJK ideographs only', () => {
    // Chinese characters (CJK Unified Ideographs)
    expect(isChinese('中')).toBe(true)
    expect(isChinese('文')).toBe(true)
    // Not Chinese
    expect(isChinese('a')).toBe(false)
    expect(isChinese('ア'), 'Japanese katakana should not be Chinese').toBe(false)
  })
})

describe('isJapanese', () => {
  it('detects kana only', () => {
    // Hiragana
    expect(isJapanese('あ')).toBe(true)
    // Katakana
    expect(isJapanese('ア')).toBe(true)
    // Half-width Katakana
    expect(isJapanese('ﾟ')).toBe(true)
    // Not Japanese
    expect(isJapanese('中'), 'Chinese should not be Japanese').toBe(false)
    expect(isJapanese('a'), "ASCII 'a' should not be Japanese").toBe(false)
  })
})
