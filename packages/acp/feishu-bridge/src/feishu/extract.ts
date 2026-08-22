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
  /** Image key of an `img` element, downloadable via the message resource API. */
  image_key?: string
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
 * @param content - Raw content JSON of a post message.
 * @returns The extracted plain text; empty when nothing textual is present.
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

/**
 * Deduped image keys embedded in a post (rich text) message, in first-seen
 * document order. Feishu delivers image+text combined as a post whose `img`
 * elements carry an `image_key` downloadable through the message resource API
 * like a pure image message.
 * @param content - Raw content JSON of a post message.
 * @returns Deduped image keys in document order.
 */
export function extractPostImageKeys(content: string): string[] {
  const post = parsePostBody(content)
  const out: string[] = []
  const seen = new Set<string>()
  for (const para of post.content ?? []) {
    for (const elem of para) {
      if (elem.tag !== 'img') continue
      const key = elem.image_key ?? ''
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Whether at least one mention targets the bot's open_id.
 * @param mentions - Mentions delivered with the message, if any.
 * @param botOpenID - The bot's own open_id.
 * @returns True when the bot is mentioned.
 */
export function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenID: string): boolean {
  for (const m of mentions ?? []) {
    if (m.id?.open_id !== undefined && m.id.open_id === botOpenID) return true
  }
  return false
}

/**
 * Whether at least one mention targets a human (MentionedType == "user").
 * @param mentions - Mentions delivered with the message, if any.
 * @returns True when a human is mentioned.
 */
export function hasHumanMention(mentions: FeishuMention[] | undefined): boolean {
  for (const m of mentions ?? []) {
    if (m.mentionedType === 'user') return true
  }
  return false
}

/**
 * Replace @_user_N mention placeholders with @name in fetched quoted text
 * (Go replaceMentions): unlike stripMentions nothing is removed — the quote
 * keeps every speaker reference readable.
 * @param text - Quoted text containing @_user_N placeholders.
 * @param mentions - Mentions delivered with the quoted message.
 * @returns The text with each placeholder replaced by its @name.
 */
export function replaceMentions(text: string, mentions: FeishuMention[] | undefined): string {
  for (const m of mentions ?? []) {
    if (m.key !== undefined && m.name !== undefined) {
      text = text.replaceAll(m.key, `@${m.name}`)
    }
  }
  return text
}

/**
 * Process @_user_N placeholders: the bot's own mention is removed; other
 * user mentions become @name (or are removed when unnamed) so the agent sees
 * who was referenced (Go stripMentions).
 * @param text - Message text containing @_user_N placeholders.
 * @param mentions - Mentions delivered with the message.
 * @param botOpenID - The bot's own open_id; its mention is removed outright.
 * @returns The processed text, trimmed.
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

// ── interactive-card text extraction (Go feishu_extract.go, #53 poll path) ──

/**
 * Returned by {@link extractInteractiveCardText} when a card yields no
 * textual content. The poll path treats it as "no text" so an image-only
 * card can fall back to downloading its embedded images.
 */
export const interactiveCardPlaceholder = '[interactive card]'

/**
 * Return the card JSON, unwrapping the two known delivery wrappers:
 * {"json_card":"<escaped JSON>"} (quoted-message fetch) and
 * {"type":"raw_card_content","raw_card_content":"<escaped JSON>"} (inbound
 * event / list response). Direct card JSON is returned as-is (Go
 * unwrapCardContent).
 * @param content - Raw card content string, possibly wrapper-encoded.
 * @returns The unescaped card JSON, or the input as-is when it is not a recognized wrapper.
 */
export function unwrapCardContent(content: string): string {
  let wrapper: { json_card?: string; raw_card_content?: string }
  try {
    wrapper = JSON.parse(content) as typeof wrapper
  } catch {
    return content
  }
  if (wrapper.raw_card_content !== undefined && wrapper.raw_card_content !== '') return wrapper.raw_card_content
  if (wrapper.json_card !== undefined && wrapper.json_card !== '') return wrapper.json_card
  return content
}

/** Structural slice of one schema 2.0 card element (Go extractCardElements's anon struct). */
interface CardElem {
  tag?: string
  content?: string
  title?: unknown
  text?: unknown
  elements?: unknown[]
  property?: {
    content?: string
    contents?: unknown
    language?: string
    elements?: unknown[]
    text?: unknown
    items?: unknown
    columns?: unknown
    rows?: unknown
    title?: unknown
  }
}
function asCardElem(raw: unknown): CardElem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return raw
}

/** Recursively extract text from schema 2.0 card elements (Go extractCardElements). */
function extractCardElements(elements: unknown[], parts: string[]): void {
  for (const raw of elements) {
    const elem = asCardElem(raw)
    if (elem === undefined) continue
    const prop = elem.property ?? {}
    switch (elem.tag) {
      case 'code_block': {
        const lines = Array.isArray(prop.contents) ? prop.contents : []
        const codeLines: string[] = []
        for (const line of lines) {
          let lineText = ''
          const tokens = (line as { contents?: unknown } | null)?.contents
          if (Array.isArray(tokens)) {
            for (const tok of tokens) {
              const t = asCardElem(tok)
              if (t?.content !== undefined) lineText += t.content
            }
          }
          codeLines.push(lineText)
        }
        const code = codeLines.join('')
        if (code.trim() !== '') {
          parts.push(prop.language !== undefined && prop.language !== '' ? `\`\`\`${prop.language}\n${code}\`\`\`` : `\`\`\`\n${code}\`\`\``)
        }
        break
      }
      case 'code_span':
        if (prop.content !== undefined && prop.content !== '') parts.push(`\`${prop.content}\``)
        break
      case 'hr':
        parts.push('---')
        break
      case 'column_set': {
        // Schema 2.0 layout: columns[] → each column's property.elements hold
        // the real content. Recurse so column-based alert metrics are not lost.
        const cols = Array.isArray(prop.columns) ? prop.columns : []
        for (const col of cols) {
          const colElements = asCardElem(col)?.property?.elements
          if (Array.isArray(colElements) && colElements.length > 0) extractCardElements(colElements, parts)
        }
        break
      }
      case 'table':
        extractCardTable(prop.columns, prop.rows, parts)
        break
      case 'list':
        extractCardListItems(prop.items, parts)
        break
      default: {
        let content = prop.content ?? ''
        if (content === '') content = elem.content ?? ''
        if (content !== '') parts.push(content)
        // Schema 2.0 div 的 property.text 是富文本容器：lark_md 被飞书解析成
        // text.property.elements[] 里的 plain_text 序列，实际文本在
        // plain_text.property.content。递归提取才不丢正文。
        if (prop.text !== undefined && prop.text !== null) {
          const textElem = asCardElem(prop.text)
          if (textElem !== undefined) {
            const tp = textElem.property ?? {}
            if (Array.isArray(tp.elements) && tp.elements.length > 0) {
              extractCardElements(tp.elements, parts)
            } else if (Array.isArray(textElem.elements) && textElem.elements.length > 0) {
              extractCardElements(textElem.elements, parts)
            } else {
              const tc = textElem.content ?? tp.content ?? ''
              if (tc !== '') parts.push(tc)
            }
          }
        }
        // Schema 1.0 风格 div/columns：元素根级直接挂 text =
        // {"tag":"lark_md"/"plain_text","content":"…"}。webhook 机器人和多数
        // 告警卡片仍发根级 text，不在这里取就会整段正文丢失。
        if (elem.text !== undefined && elem.text !== null) {
          const t = asCardElem(elem.text)
          const tc = t?.content ?? t?.property?.content ?? ''
          if (tc !== '') parts.push(tc)
        }
        break
      }
    }
    if (Array.isArray(prop.elements) && prop.elements.length > 0) {
      extractCardElements(prop.elements, parts)
    }
  }
}

/** Extract a markdown table from a card table element (Go extractCardTable). */
function extractCardTable(columnsRaw: unknown, rowsRaw: unknown, parts: string[]): void {
  const columns = Array.isArray(columnsRaw)
    ? columnsRaw.flatMap((c) => {
      if (typeof c !== 'object' || c === null) return []
      const col = c as { displayName?: string; name?: string }
      return [{ displayName: col.displayName ?? '', name: col.name ?? '' }]
    })
    : []
  if (columns.length === 0) return
  const rows: unknown[] = Array.isArray(rowsRaw) ? rowsRaw : []

  parts.push(`| ${columns.map(c => c.displayName).join(' | ')} |`)
  parts.push(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) {
    const cells = columns.map(() => '')
    if (typeof row === 'object' && row !== null) {
      for (const [key, value] of Object.entries(row)) {
        const idx = columns.findIndex(c => c.name === key)
        if (idx === -1) continue
        const cellParts: string[] = []
        const data = (value as { data?: unknown }).data
        if (data !== undefined && data !== null) extractCardElements([data], cellParts)
        cells[idx] = cellParts.join(' ')
      }
    }
    parts.push(`| ${cells.join(' | ')} |`)
  }
}

/** Extract text from a card list element's items (Go extractCardListItems). */
function extractCardListItems(itemsRaw: unknown, parts: string[]): void {
  const items = Array.isArray(itemsRaw) ? itemsRaw : []
  for (const item of items) {
    const elements = (item as { elements?: unknown } | null)?.elements
    if (!Array.isArray(elements)) continue
    const itemParts: string[] = []
    extractCardElements(elements, itemParts)
    if (itemParts.length > 0) parts.push(`- ${itemParts.join(' ')}`)
  }
}

/**
 * Extract readable text from a Feishu interactive card JSON (Go
 * extractInteractiveCardText): header title first (schema 2.0 nested or
 * legacy flat) so the alert name leads, then body elements (schema 2.0
 * property.elements / direct elements, or legacy flat text elements).
 * @param content - Raw card content string (wrapper-encoded or direct card JSON).
 * @returns The extracted text, or interactiveCardPlaceholder when the card yields no text.
 */
export function extractInteractiveCardText(content: string): string {
  const cardJSON = unwrapCardContent(content)
  let card: Record<string, unknown>
  try {
    card = JSON.parse(cardJSON) as Record<string, unknown>
  } catch {
    return interactiveCardPlaceholder
  }
  const parts: string[] = []

  // Header title — schema 2.0 (header.property.title.property.content or
  // header.title.content) or legacy (header.title.content as plain string).
  const header = asCardElem(card.header)
  if (header !== undefined) {
    const t = asCardElem(header.property)?.title ?? header.title
    const title = asCardElem(t)
    const text = title?.property?.content ?? title?.content ?? ''
    if (text !== '') parts.push(text)
  }
  // Legacy direct title string.
  if (parts.length === 0 && typeof card.title === 'string' && card.title !== '') {
    parts.push(card.title)
  }

  // Schema 2.0: body.property.elements (standard) or body.elements (simplified).
  let hasBody = false
  const body = asCardElem(card.body)
  if (body !== undefined) {
    hasBody = true
    const propElements = body.property?.elements
    if (Array.isArray(propElements) && propElements.length > 0) {
      extractCardElements(propElements, parts)
    } else if (Array.isArray(body.elements) && body.elements.length > 0) {
      extractCardElements(body.elements, parts)
    }
  }

  // Legacy: flat/nested elements (cards without a schema 2.0 body). The text
  // lives in the element's root `text` field (Go's anon struct reads Text).
  if (!hasBody) {
    const rawList = Array.isArray(card.elements) ? card.elements as unknown[] : undefined
    let elements: unknown[] | undefined
    if (rawList !== undefined) {
      const nested: unknown = rawList[0]
      elements = Array.isArray(nested) ? rawList.flat() : rawList
    }
    for (const el of elements ?? []) {
      const elem = asCardElem(el)
      const text = typeof elem?.text === 'string' ? elem.text : ''
      if (elem !== undefined && elem.tag === 'text' && text.trim() !== '') {
        parts.push(text)
      }
    }
  }

  if (parts.length === 0) return interactiveCardPlaceholder
  return parts.join('\n')
}

/**
 * Pull readable text from a listed message's content by type (Go
 * extractPollText): text JSON, post rich text (both the pure-array form the
 * list API returns and the locale-wrapped whole-post form), or an interactive
 * card.
 * @param msgType - Feishu msg_type of the listed message.
 * @param content - Raw message content JSON.
 * @returns The readable text for the type; empty for unsupported types.
 */
export function extractPollText(msgType: string, content: string): string {
  switch (msgType) {
    case 'text': {
      try {
        return (JSON.parse(content) as { text?: string }).text ?? ''
      } catch {
        return ''
      }
    }
    case 'post':
      return extractPostPlainText(content)
    case 'interactive':
      return extractInteractiveCardText(content)
    default:
      return ''
  }
}

/**
 * Deduped image keys embedded in a card JSON, first-seen order, regardless of
 * nesting (schema 1.0 image_key / schema 2.0 img_key). Run on UNWRAPPED card
 * JSON so escaped wrappers don't break the match (Go extractCardImageKeys).
 * @param cardJSON - Unwrapped card JSON string.
 * @returns Deduped image keys in first-seen order.
 */
export function extractCardImageKeys(cardJSON: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /"(?:image_key|img_key)"\s*:\s*"([^"]+)"/g
  for (const m of cardJSON.matchAll(re)) {
    const k = m[1] ?? ''
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
