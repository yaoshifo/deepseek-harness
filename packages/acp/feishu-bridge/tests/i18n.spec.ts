import { describe, expect, it } from 'vitest'
import {
  Msg,
  ALL_MSG_KEYS,
  type Language,
  detectLanguage,
  I18n,
  isChinese,
  isJapanese,
  langChinese,
  langEnglish,
  langTraditionalChinese,
  lookupMessage,
  messages,
  registerMessages,
} from '../src/i18n/index.ts'

// Ported from cc-connect core/i18n/i18n_test.go (11 Go tests).
//
// Go's open `type Language string` / `type MsgKey string` accept any string;
// the TS unions are closed, so the fallback-coverage tests cast their
// deliberately-invalid literals.

describe('I18n', () => {
  it('DefaultLanguage', () => {
    const i = new I18n(langEnglish)
    expect(i.t(Msg.Processing)).not.toBe('')
  })

  it('Chinese', () => {
    const i = new I18n(langChinese)
    const got = i.t(Msg.Processing)
    expect(got).not.toBe('')
    // Should contain Chinese characters, not English
    expect(got).not.toBe('Request sent to the model, waiting for response...')
  })

  it('FallbackToEnglish', () => {
    // Language is an open union (Go's `type Language string`), so no cast needed.
    const i = new I18n('nonexistent')
    expect(i.t(Msg.Processing)).not.toBe('')
  })

  it('MissingKey', () => {
    const i = new I18n(langEnglish)
    // Go's T returns the raw key for missing entries; the Go test only
    // logged (never failed) on other outcomes.
    expect(i.t('totally_missing_key')).toBe('totally_missing_key')
  })

  it('Tf', () => {
    const i = new I18n(langEnglish)
    expect(i.tf(Msg.RenameDone, 'myname')).not.toBe('')
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

describe('lookupMessage', () => {
  it('hits per language like I18n.t', () => {
    expect(lookupMessage(langEnglish, Msg.Thinking)).toBe('💭 %s')
    expect(lookupMessage(langChinese, Msg.RenameDone, '新名字')).toBe('✅ 已重命名为：新名字')
  })

  it('substitutes Go-style format verbs like I18n.tf', () => {
    expect(lookupMessage(langChinese, Msg.QueueFull, 3)).toBe('📬 消息队列已满（3 条待处理）。请等待当前任务完成。')
    expect(lookupMessage(langEnglish, Msg.HelpUnknownCmd, '/x')).toBe('Unknown command: /x\n')
    // No args: template passes through unchanged, matching tf with zero args.
    expect(lookupMessage(langEnglish, Msg.QueueFull)).toBe('📬 Message queue is full (%d pending). Please wait for current tasks to complete.')
  })

  it('returns the raw key for a missing entry', () => {
    expect(lookupMessage(langEnglish, 'totally_missing_key')).toBe('totally_missing_key')
  })

  it('matches I18n.t across the fallback chain', () => {
    for (const lang of [langEnglish, langChinese, langTraditionalChinese, 'ja', 'es', 'nonexistent'] as Language[]) {
      const i = new I18n(lang)
      for (const key of ALL_MSG_KEYS) {
        expect(lookupMessage(lang, key), `${lang} ${key}`).toBe(i.t(key))
      }
    }
  })
})

describe('platform-owned copy (perm card rebuilds, export/sendreply notices)', () => {
  it('carries the five platform strings with the pre-i18n hardcoded Chinese', () => {
    // zh pins the exact pre-i18n literals: the platform falls back to them
    // when no handle is wired, so the table values must stay byte-identical.
    expect(messages[Msg.PermResultAllow]).toEqual({ en: '✅ Allowed', zh: '✅ 已允许' })
    expect(messages[Msg.PermResultDeny]).toEqual({ en: '❌ Denied', zh: '❌ 已拒绝' })
    expect(messages[Msg.PermResultAllowAll]).toEqual({ en: '✅ Allowed all', zh: '✅ 已全部允许' })
    expect(messages[Msg.ExportNotFound]).toEqual({
      en: 'Export failed: content not found; the session may have expired',
      zh: '导出失败：未找到对应内容，可能会话已过期',
    })
    expect(messages[Msg.SendReplyNotFound]).toEqual({
      en: 'Content not found; the session may have expired',
      zh: '未找到对应内容，可能会话已过期',
    })
  })
})

describe('registerMessages', () => {
  /** A disposable subtable the tests clean up after themselves. */
  const subtableA = { en: { spec_sub_a: 'A' }, zh: { spec_sub_a: 'A·zh' } }

  it('serves subtable keys through I18n.t and lookupMessage with the same fallback chain', () => {
    const dispose = registerMessages(subtableA)
    try {
      expect(new I18n(langEnglish).t('spec_sub_a')).toBe('A')
      expect(new I18n(langChinese).t('spec_sub_a')).toBe('A·zh')
      // Traditional Chinese falls back to Simplified; an unknown language to English.
      expect(new I18n(langTraditionalChinese).t('spec_sub_a')).toBe('A·zh')
      expect(new I18n('nonexistent').t('spec_sub_a')).toBe('A')
      expect(lookupMessage(langEnglish, 'spec_sub_a')).toBe('A')
      // The main table still wins over subtables.
      expect(new I18n(langEnglish).t(Msg.Processing)).not.toBe('')
    } finally {
      dispose()
    }
    expect(new I18n(langEnglish).t('spec_sub_a')).toBe('spec_sub_a')
  })

  it('reference-counts re-registrations of the same object and tolerates double dispose', () => {
    const disposeOne = registerMessages(subtableA)
    const disposeTwo = registerMessages(subtableA)
    disposeOne()
    expect(new I18n(langEnglish).t('spec_sub_a')).toBe('A')
    disposeTwo()
    disposeTwo()
    expect(new I18n(langEnglish).t('spec_sub_a')).toBe('spec_sub_a')
  })

  it('rejects keys colliding with the main table and with another subtable', () => {
    expect(() => registerMessages({ en: { thinking: 'dup' } })).toThrow(/collides with the main message table/)
    const disposeOther = registerMessages({ en: { spec_sub_b: 'B' } })
    try {
      expect(() => registerMessages({ en: { spec_sub_b: 'conflict' } })).toThrow(/already registered by another subtable/)
    } finally {
      disposeOther()
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
