/**
 * Feishu text extraction helpers ported from cc-connect
 * platform/feishu/feishu_extract.go and feishu_user.go: rich-text (post)
 * plain-text extraction with locale unwrapping, @-mention handling, and the
 * mention strip used before dispatching text to the engine.
 *
 * @module dsh-feishu-bridge/feishu-extract
 */

/** One @-mention as delivered on im.message.receive_v1. */
export interface FeishuMention {
  key?: string
  id?: { open_id?: string }
  name?: string
  mentionedType?: string
}

/** Plain-text extraction element (post rich text). */
interface PostElement {
  tag?: string
  text?: string
  language?: string
  user_id?: string
  user_name?: string
}

interface PostBody {
  content?: PostElement[][]
  title?: string
}

function parsePostBody(content: string): PostBody {
  let post: PostBody | undefined
  try {
    const direct = JSON.parse(content) as PostBody
    if (Array.isArray(direct.content)) post = direct
  } catch {
    // fall through to locale-wrapper parse
  }
  if (post === undefined) {
    try {
      const wrapper = JSON.parse(content) as Record<string, unknown>
      for (const value of Object.values(wrapper)) {
        if (typeof value !== 'string') {
          const candidate = value as PostBody
          if (Array.isArray(candidate.content)) {
            post = candidate
            break
          }
        }
      }
    } catch {
      // unparseable → empty
    }
  }
  return post ?? {}
}

/**
 * Extract plain text from a Feishu post (rich text) JSON content string,
 * unwrapping locale keys ({"zh_cn": …}) first (Go extractPostPlainText).
 */
export function extractPostPlainText(content: string): string {
  const post = parsePostBody(content)
  const paragraphs = post.content ?? []
  if (paragraphs.length === 0) return ''
  const parts: string[] = []
  if (post.title !== undefined && post.title !== '') parts.push(post.title)
  for (const para of paragraphs) {
    const line: string[] = []
    for (const elem of para) {
      switch (elem.tag) {
        case 'text':
        case 'a':
        case 'markdown':
          if (elem.text !== undefined && elem.text !== '') line.push(elem.text)
          break
        case 'at':
          if (elem.user_id === 'all') line.push('@all')
          else if (elem.user_name !== undefined && elem.user_name !== '') line.push(`@${elem.user_name}`)
          else if (elem.user_id !== undefined && elem.user_id !== '') line.push('@user')
          break
        case 'img':
          line.push('[image]')
          break
        case 'code_block':
          if (elem.text !== undefined && elem.text !== '') {
            line.push('```' + (elem.language ?? '') + '\n' + elem.text + '\n```')
          }
          break
        default:
          break
      }
    }
    if (line.length > 0) parts.push(line.join(''))
  }
  return parts.join('\n')
}

/** Whether at least one mention targets the bot's open_id. */
export function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenID: string): boolean {
  for (const m of mentions ?? []) {
    if (m.id?.open_id !== undefined && m.id.open_id === botOpenID) return true
  }
  return false
}

/** Whether at least one mention targets a human (MentionedType == "user"). */
export function hasHumanMention(mentions: FeishuMention[] | undefined): boolean {
  for (const m of mentions ?? []) {
    if (m.mentionedType === 'user') return true
  }
  return false
}

/**
 * Process @_user_N placeholders: the bot's own mention is removed; other
 * user mentions become @name (or are removed when unnamed) so the agent sees
 * who was referenced (Go stripMentions).
 */
export function stripMentions(text: string, mentions: FeishuMention[] | undefined, botOpenID: string): string {
  if (mentions === undefined || mentions.length === 0) return text
  for (const m of mentions) {
    if (m.key === undefined) continue
    if (botOpenID !== '' && m.id?.open_id !== undefined && m.id.open_id === botOpenID) {
      text = text.replaceAll(m.key, '')
    } else if (m.name !== undefined && m.name !== '') {
      text = text.replaceAll(m.key, `@${m.name}`)
    } else {
      text = text.replaceAll(m.key, '')
    }
  }
  return text.trim()
}
