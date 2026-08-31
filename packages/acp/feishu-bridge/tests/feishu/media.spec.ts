import { describe, expect, it } from 'vitest'
import { FeishuPlatform, collectDownloadStream, type FeishuApiClient, type FeishuReceiveEvent } from '../../src/feishu/platform.js'
import { detectFeishuFileType, detectMimeType, maxFeishuDownloadBytes } from '../../src/feishu/media.js'
import { I18n, langEnglish } from '../../src/i18n/index.js'
import type { Message } from '../../src/core/types.js'

// Ported from cc-connect platform/feishu/feishu_media_test.go: a failed
// attachment download must notify the user via a direct reply (never through
// the agent handler), naming the failed attachment.

function newPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_media',
    appSecret: 'secret',
    apiClient: api,
    wsStart: async () => {},
  })
}

function fileEvent(): FeishuReceiveEvent {
  return {
    message: {
      message_id: 'om_root',
      chat_id: 'oc_chat',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_v3_x', file_name: 'DCE.zip' }),
      chat_type: 'p2p',
      create_time: String(Date.now()),
    },
    sender: { sender_id: { open_id: 'ou_user' } },
  }
}

describe('replyDownloadError', () => {
  it('replies with the file name and failure text', async () => {
    const replies: Array<{ messageId: string; msgType: string; content: string }> = []
    const api: FeishuApiClient = {
      async reply(params) {
        replies.push(params)
        return { messageId: 'om_ok' }
      },
      async create() {
        return { messageId: 'om_ok' }
      },
    }
    const p = newPlatform(api)

    await p.replyDownloadError(
      { messageID: 'om_root', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat' },
      '文件',
      'DCE.zip',
    )

    expect(replies).toHaveLength(1)
    expect(replies[0]!.msgType).toBe('text')
    expect(replies[0]!.content).toContain('DCE.zip')
    expect(replies[0]!.content).toContain('下载失败')
  })

  it('localizes the named failure through the i18n handle', async () => {
    const replies: Array<{ messageId: string; msgType: string; content: string }> = []
    const api: FeishuApiClient = {
      async reply(params) {
        replies.push(params)
        return { messageId: 'om_ok' }
      },
      async create() {
        return { messageId: 'om_ok' }
      },
    }
    const p = newPlatform(api)
    p.setI18nHandle(new I18n(langEnglish))

    await p.replyDownloadError(
      { messageID: 'om_root', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat' },
      'file',
      'DCE.zip',
    )

    expect(replies).toHaveLength(1)
    // The text message body is JSON-encoded, so the quoted name arrives escaped.
    expect(replies[0]!.content).toContain('Failed to download the file')
    expect(replies[0]!.content).toContain('DCE.zip')
    expect(replies[0]!.content).not.toContain('下载失败')
  })

  it('localizes the kind label on the dispatch path', async () => {
    const replies: Array<{ messageId: string; msgType: string; content: string }> = []
    const api: FeishuApiClient = {
      async reply(params) {
        replies.push(params)
        return { messageId: 'om_ok' }
      },
      async create() {
        return { messageId: 'om_ok' }
      },
      async downloadMessageResource() {
        throw new Error('boom')
      },
    }
    const p = newPlatform(api)
    p.setI18nHandle(new I18n(langEnglish))
    await p.start(() => {})

    p.onMessage(fileEvent())
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(replies).toHaveLength(1)
    expect(replies[0]!.content).toContain('Failed to download the file')
    expect(replies[0]!.content).not.toContain('下载失败')
  })
})

describe('dispatch file message', () => {
  it('replies when the download fails instead of returning silently', async () => {
    const replies: Array<{ messageId: string; msgType: string; content: string }> = []
    const api: FeishuApiClient = {
      async reply(params) {
        replies.push(params)
        return { messageId: 'om_ok' }
      },
      async create() {
        return { messageId: 'om_ok' }
      },
      async downloadMessageResource() {
        throw new Error('resource API code=400 msg=bad request')
      },
    }
    const p = newPlatform(api)
    await p.start(() => {})

    p.onMessage(fileEvent())
    // The file branch downloads asynchronously before dispatching.
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(replies).toHaveLength(1)
    expect(replies[0]!.content).toContain('DCE.zip')
  })

  it('treats an over-cap download as a failure instead of dispatching a truncated attachment', async () => {
    const replies: Array<{ messageId: string; msgType: string; content: string }> = []
    const dispatched: Message[] = []
    const api: FeishuApiClient = {
      async reply(params) {
        replies.push(params)
        return { messageId: 'om_ok' }
      },
      async create() {
        return { messageId: 'om_ok' }
      },
      async downloadMessageResource() {
        return new Uint8Array(maxFeishuDownloadBytes + 1)
      },
    }
    const p = newPlatform(api)
    await p.start((_platform, msg) => { dispatched.push(msg) })

    p.onMessage(fileEvent())
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    // An oversized resource must reach the agent never: silently truncating
    // it hands the agent a corrupted file that looks complete.
    expect(dispatched).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.content).toContain('DCE.zip')
    expect(replies[0]!.content).toContain('下载失败')
  })
})

describe('collectDownloadStream', () => {
  it('aborts an over-cap stream mid-transfer instead of draining or truncating it', async () => {
    const chunk = Buffer.alloc(1024 * 1024)
    let yielded = 0
    async function* oversized(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 200; i++) {
        yielded++
        yield chunk
      }
    }

    await expect(collectDownloadStream(oversized())).rejects.toThrow('exceeds')
    // The transfer must stop once the running length crosses the cap
    // (chunk 101 of 1MB each), not drain all 200MB into memory.
    expect(yielded).toBeLessThanOrEqual(102)
  })

  it('returns the complete bytes of an in-cap stream', async () => {
    const first = Buffer.from('feishu')
    const second = Buffer.from('download')
    async function* resource(): AsyncGenerator<Buffer> {
      yield first
      yield second
    }

    expect(await collectDownloadStream(resource())).toEqual(new Uint8Array(Buffer.concat([first, second])))
  })
})

describe('detectFeishuFileType', () => {
  it.each([
    ['pdf by mime', 'application/pdf', 'whatever.bin', 'pdf'],
    ['pdf by name', '', 'report.PDF', 'pdf'],
    ['doc', '', 'a.docx', 'doc'],
    ['xls family', '', 'a.xlsx', 'xls'],
    ['csv', '', 'a.csv', 'xls'],
    ['ppt', '', 'a.pptx', 'ppt'],
    ['mp4 by mime', 'video/mp4', 'a.bin', 'mp4'],
    ['opus by mime', 'audio/ogg', 'a.bin', 'opus'],
    ['opus by name', '', 'a.opus', 'opus'],
    ['stream fallback', 'text/plain', 'notes', 'stream'],
  ])('%s', (_name, mimeType, fileName, want) => {
    expect(detectFeishuFileType(mimeType, fileName)).toBe(want)
  })
})

describe('detectMimeType', () => {
  it.each([
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0], 'image/jpeg'],
    ['gif', [...Array.from(new TextEncoder().encode('GIF89a')), 0, 0, 0, 0], 'image/gif'],
    ['webp', [...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP')], 'image/webp'],
    ['short unknown falls back to png', [1, 2], 'image/png'],
    ['fallback', [1, 2, 3, 4, 5, 6, 7, 8], 'image/png'],
  ])('%s', (_name, bytes, want) => {
    expect(detectMimeType(new Uint8Array(bytes))).toBe(want)
  })
})
