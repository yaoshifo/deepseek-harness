/**
 * Structured rich-message card model and builder, ported from cc-connect
 * core/card.go. Platform-specific rendering (Feishu Interactive Card, etc.)
 * consumes these; `renderText` is the plain-text degradation.
 *
 * Go's CardElement interface with marker methods maps to this discriminated
 * union on `kind`; Go struct literals map to object literals.
 *
 * @module dsh-feishu-bridge/card
 */

import { sprintf } from './sprintf.js'

/**
 * Optional colored title bar of a card. Color: blue, green, red, orange,
 * purple, grey, turquoise, violet, indigo, wathet, yellow, carmine.
 */
export interface CardHeader {
  title: string
  color: string
}

/** Clickable inline button (used by platform send-with-buttons APIs). */
export interface ButtonOption {
  /** Display text on the button. */
  text: string
  /** Callback data returned when clicked (≤64 bytes for Telegram). */
  data: string
}

/** Clickable button inside an actions element or form. */
export interface CardButton {
  text: string
  /** "primary", "default", or "danger". */
  type: string
  /** Callback data, e.g. "cmd:/new", "cmd:/switch 3". */
  value: string
  /** When set, clicking opens this URL directly (no callback). */
  url?: string
  /** Additional key-value pairs carried in the callback (platform-specific). */
  extra?: Record<string, string>
  /** "form_submit" to submit the parent form, or empty. */
  actionType?: string
  /** Component name inside a form (Feishu requires this). */
  name?: string
}

/** How an actions row should be laid out on platforms with richer layouts. */
export type CardActionLayout = 'row' | 'equal_columns'

/** Renders markdown-formatted text. */
export interface CardMarkdown { kind: 'markdown'; content: string }

/** Renders a horizontal rule. */
export interface CardDivider { kind: 'divider' }

/** Renders a row of clickable buttons. */
export interface CardActions {
  kind: 'actions'
  buttons: CardButton[]
  layout: CardActionLayout
  /**
   * When non-empty, rendered as a trailing auto-width column on the button
   * row (small grey text) so a status line shares the row with the buttons.
   */
  note?: string
}

/** Renders small footnote text at the bottom. */
export interface CardNote {
  kind: 'note'
  text: string
  /** Optional machine-readable identifier (not displayed) for platform renderers. */
  tag?: string
}

/** Renders description text on the left and a button on the right (Feishu div+extra). */
export interface CardListItem {
  kind: 'listItem'
  text: string
  description?: string
  btnText: string
  btnType: string
  btnValue: string
  btnUrl?: string
  extra?: Record<string, string>
  btn2Text?: string
  btn2Type?: string
  btn2Value?: string
  btn2Disabled?: boolean
  btn2Tip?: string
}

/** One item in a select dropdown. */
export interface CardSelectOption { text: string; value: string }

/** Renders a dropdown selector (Feishu select_static). */
export interface CardSelect {
  kind: 'select'
  placeholder: string
  options: CardSelectOption[]
  /** Pre-selected option value (empty = none). */
  initValue?: string
}

/** One checkbox item in a check-options element. */
export interface CardCheckOption {
  label: string
  description?: string
  /** Submitted value, typically the option index (e.g. "1", "2"). */
  value?: string
}

/** Renders checkboxes for multi-select questions (Feishu checker inside a form). */
export interface CardCheckOptions {
  kind: 'checkOptions'
  question?: string
  options: CardCheckOption[]
  /** Form submit action, e.g. "askq_multi:0". */
  action?: string
  extra?: Record<string, string>
}

/** Renders an image by platform-specific image key (e.g. a Feishu image_key). */
export interface CardImage {
  kind: 'image'
  imageKey: string
  alt?: string
  /** Empty = platform default (crop_center); "fit_horizontal" = full image, no cropping, width fills card. */
  scaleType?: string
}

/** Renders a collapsible section (Feishu collapsible_panel). */
export interface CardCollapsiblePanel {
  kind: 'collapsiblePanel'
  expanded?: boolean
  title?: string
  titleIsMD?: boolean
  border?: string
  elements: CardElement[]
}

/** Wraps input elements and submit buttons in a form container (Feishu form). */
export interface CardForm {
  kind: 'form'
  name?: string
  elements: CardElement[]
}

/** Single-line text input; must sit inside a form for its value to submit. */
export interface CardInput {
  kind: 'input'
  name?: string
  placeholder?: string
  maxLength?: number
}

/** One column inside a column set. */
export interface CardColumn {
  width?: 'auto' | 'weighted'
  /** Weight for "weighted" columns (default 1). */
  weight?: number
  elements: CardElement[]
}

/** Renders children side-by-side in columns (Feishu column_set). */
export interface CardColumnSet {
  kind: 'columnSet'
  columns: CardColumn[]
}

/** Closed union of card content elements. */
export type CardElement =
  | CardMarkdown
  | CardDivider
  | CardActions
  | CardNote
  | CardListItem
  | CardSelect
  | CardCheckOptions
  | CardImage
  | CardCollapsiblePanel
  | CardForm
  | CardInput
  | CardColumnSet

/** Shorthand constructor for a plain button. */
export const btn = (text: string, type: string, value: string): CardButton => ({ text, type, value })

/** Shorthand constructor for a primary-styled button. */
export const primaryBtn = (text: string, value: string): CardButton => ({ text, type: 'primary', value })

/** Shorthand constructor for a default-styled button. */
export const defaultBtn = (text: string, value: string): CardButton => ({ text, type: 'default', value })

/** Shorthand constructor for a danger-styled button. */
export const dangerBtn = (text: string, value: string): CardButton => ({ text, type: 'danger', value })

/**
 * Append `el` into the elements of the last collapsible panel nested (one
 * level deep) inside a form in `elements`. With no such panel, falls back to
 * a top-level append so the element stays visible (just not folded).
 *
 * Unlike the Go source (in-place slice mutation), this returns a new array;
 * all ported call sites reassign the result.
 * @param elements - Current element list.
 * @param el - Element to append.
 * @returns The updated element list.
 */
export function appendIntoLastCollapsible(elements: CardElement[], el: CardElement): CardElement[] {
  for (let i = elements.length - 1; i >= 0; i--) {
    const form = elements[i]
    if (form?.kind !== 'form') {
      continue
    }
    for (const [j, fe] of form.elements.entries()) {
      if (fe.kind === 'collapsiblePanel') {
        const panel: CardCollapsiblePanel = { ...fe, elements: [...fe.elements, el] }
        const updatedForm: CardForm = {
          ...form,
          elements: form.elements.map((e, idx) => (idx === j ? panel : e)),
        }
        return elements.map((e, idx) => (idx === i ? updatedForm : e))
      }
    }
  }
  return [...elements, el]
}

/**
 * A structured rich message renderable as platform-specific cards (Feishu
 * Interactive Card, etc.) or degraded to plain text.
 */
export class Card {
  header?: CardHeader
  elements: CardElement[] = []
  /** Metadata cached by platforms for callback card replacement. */
  permBody?: string

  /** Convert the card to plain text for platforms without rich-card support. */
  renderText(): string {
    let sb = ''

    if (this.header !== undefined && this.header.title !== '') {
      sb += `**${this.header.title}**\n\n`
    }

    for (const elem of this.elements) {
      switch (elem.kind) {
        case 'markdown':
          sb += `${elem.content}\n\n`
          break
        case 'divider':
          sb += '---\n\n'
          break
        case 'actions':
          // Render buttons as a hint line
          for (const [i, btnEl] of elem.buttons.entries()) {
            if (i > 0) sb += '  '
            sb += `[${btnEl.text}]`
          }
          sb += '\n\n'
          break
        case 'listItem':
          sb += elem.text
          sb += `  [${elem.btnText}]`
          if ((elem.btn2Text ?? '') !== '') {
            sb += ` [${elem.btn2Text ?? ''}]`
          }
          sb += '\n'
          break
        case 'select':
          sb += `${elem.placeholder}: `
          for (const [i, opt] of elem.options.entries()) {
            if (i > 0) sb += ' | '
            sb += opt.text
          }
          sb += '\n\n'
          break
        case 'checkOptions':
          if ((elem.question ?? '') !== '') {
            sb += `**${elem.question ?? ''}**\n`
          }
          for (const [i, opt] of elem.options.entries()) {
            sb += `☐ ${i + 1}. ${opt.label}`
            if ((opt.description ?? '') !== '') {
              sb += ` — ${elem.options[i]?.description ?? ''}`
            }
            sb += '\n'
          }
          sb += '\n'
          break
        case 'note':
          sb += `${elem.text}\n`
          break
        case 'image':
          sb += '[image]\n'
          break
        case 'form':
          for (const child of elem.elements) {
            if (child.kind === 'actions') {
              for (const [i, btnEl] of child.buttons.entries()) {
                if (i > 0) sb += '  '
                sb += `[${btnEl.text}]`
              }
              sb += '\n'
            } else if (child.kind === 'input') {
              sb += `[${child.placeholder ?? ''}]\n`
            }
          }
          break
        default:
          // collapsiblePanel / columnSet have no text degradation (mirrors Go).
          break
      }
    }

    return sb.replace(/\n+$/, '')
  }

  /**
   * Whether the card contains interactive elements. Top level only — a
   * button inside a collapsible panel does not count, mirroring Go.
   */
  hasButtons(): boolean {
    return this.elements.some(e =>
      e.kind === 'actions' || e.kind === 'listItem' || e.kind === 'select' || e.kind === 'checkOptions' || e.kind === 'form')
  }

  /**
   * Extract all buttons as rows (one row per actions element; list items
   * become single-button rows), walking into forms and collapsible panels.
   */
  collectButtons(): ButtonOption[][] {
    const rows: ButtonOption[][] = []
    const walk = (elements: CardElement[]): void => {
      for (const elem of elements) {
        switch (elem.kind) {
          case 'actions': {
            const row = elem.buttons.map(b => ({ text: b.text, data: b.value }))
            if (row.length > 0) {
              rows.push(row)
            }
            break
          }
          case 'listItem': {
            const row: ButtonOption[] = [{ text: elem.btnText, data: elem.btnValue }]
            if ((elem.btn2Value ?? '') !== '' && !elem.btn2Disabled) {
              row.push({ text: elem.btn2Text ?? '', data: elem.btn2Value ?? '' })
            }
            rows.push(row)
            break
          }
          case 'form':
            walk(elem.elements)
            break
          case 'collapsiblePanel':
            walk(elem.elements)
            break
          default:
            break
        }
      }
    }
    walk(this.elements)
    return rows
  }
}

/** Fluent Card constructor. */
export class CardBuilder {
  private readonly card: Card = new Card()

  /** Set the card header with a title and color. */
  title(title: string, color: string): this {
    this.card.header = { title, color }
    return this
  }

  /** Append a markdown text element; empty content is skipped. */
  markdown(content: string): this {
    if (content !== '') {
      this.card.elements.push({ kind: 'markdown', content })
    }
    return this
  }

  /** Append a Go-style formatted markdown text element. */
  markdownf(format: string, ...args: unknown[]): this {
    return this.markdown(sprintf(format, ...args))
  }

  /** Append a horizontal divider. */
  divider(): this {
    this.card.elements.push({ kind: 'divider' })
    return this
  }

  /** Append an action row with the given buttons; empty rows are skipped. */
  buttons(...buttons: CardButton[]): this {
    if (buttons.length > 0) {
      this.card.elements.push({ kind: 'actions', buttons, layout: 'row' })
    }
    return this
  }

  /** Append an action row where each button takes equal width on platforms with richer layouts. */
  buttonsEqual(...buttons: CardButton[]): this {
    if (buttons.length > 0) {
      this.card.elements.push({ kind: 'actions', buttons, layout: 'equal_columns' })
    }
    return this
  }

  /** Append a list row: description on the left, default-styled button on the right. */
  listItem(desc: string, btnText: string, btnValue: string): this {
    this.card.elements.push({ kind: 'listItem', text: desc, btnText, btnType: 'default', btnValue })
    return this
  }

  /** Like {@link CardBuilder.listItem} with an explicit button type. */
  listItemBtn(desc: string, btnText: string, btnType: string, btnValue: string): this {
    this.card.elements.push({ kind: 'listItem', text: desc, btnText, btnType, btnValue })
    return this
  }

  /** Like {@link CardBuilder.listItemBtn} with extra callback data. */
  listItemBtnExtra(
    label: string,
    description: string,
    btnText: string,
    btnType: string,
    btnValue: string,
    extra?: Record<string, string>,
  ): this {
    this.card.elements.push(extra === undefined
      ? { kind: 'listItem', text: label, description, btnText, btnType, btnValue }
      : { kind: 'listItem', text: label, description, btnText, btnType, btnValue, extra })
    return this
  }

  /** Append a list row whose button opens a URL directly. */
  listItemURL(text: string, btnText: string, btnType: string, btnURL: string): this {
    this.card.elements.push({ kind: 'listItem', text, btnText, btnType, btnValue: '', btnUrl: btnURL })
    return this
  }

  /** Append a list row with a URL (jump) button plus a second callback button, which may render disabled. */
  listItemURLAction(text: string, btnText: string, btnType: string, btnURL: string,
    btn2Text: string, btn2Type: string, btn2Value: string, btn2Disabled: boolean, btn2Tip: string): this {
    this.card.elements.push({
      kind: 'listItem',
      text,
      btnText,
      btnType,
      btnValue: '',
      btnUrl: btnURL,
      btn2Text,
      btn2Type,
      btn2Value,
      btn2Disabled,
      btn2Tip,
    })
    return this
  }

  /** Append a dropdown selector; empty option lists are skipped. */
  select(placeholder: string, options: CardSelectOption[], initValue: string): this {
    if (options.length > 0) {
      this.card.elements.push({ kind: 'select', placeholder, options, initValue })
    }
    return this
  }

  /** Append a multi-select checkbox element; empty option lists are skipped. */
  checkOptions(question: string, options: CardCheckOption[], action: string, extra?: Record<string, string>): this {
    if (options.length > 0) {
      this.card.elements.push(extra === undefined
        ? { kind: 'checkOptions', question, options, action }
        : { kind: 'checkOptions', question, options, action, extra })
    }
    return this
  }

  /** Append a footnote element; empty text is skipped. */
  note(text: string): this {
    if (text !== '') {
      this.card.elements.push({ kind: 'note', text })
    }
    return this
  }

  /** Append a tagged footnote element (machine-readable tag); empty text is skipped. */
  taggedNote(tag: string, text: string): this {
    if (text !== '') {
      this.card.elements.push({ kind: 'note', text, tag })
    }
    return this
  }

  /** Append an image element; empty image keys are skipped. */
  image(imageKey: string, alt: string): this {
    if (imageKey !== '') {
      this.card.elements.push({ kind: 'image', imageKey, alt })
    }
    return this
  }

  /**
   * Append a full-width image that shows the complete image without cropping
   * (Feishu scale_type=fit_horizontal). Use for tall screenshots where the
   * default crop_center would limit height and shrink width.
   */
  imageFill(imageKey: string, alt: string): this {
    if (imageKey !== '') {
      this.card.elements.push({ kind: 'image', imageKey, alt, scaleType: 'fit_horizontal' })
    }
    return this
  }

  /** Append a collapsible panel; empty element lists are skipped. */
  collapsiblePanel(title: string, expanded: boolean, ...elements: CardElement[]): this {
    if (elements.length > 0) {
      this.card.elements.push({ kind: 'collapsiblePanel', title, expanded, elements })
    }
    return this
  }

  /** Append a form container; empty element lists are skipped. */
  form(name: string, ...elements: CardElement[]): this {
    if (elements.length > 0) {
      this.card.elements.push({ kind: 'form', name, elements })
    }
    return this
  }

  /** Return the constructed card. */
  build(): Card {
    return Object.assign(new Card(), { header: this.card.header, elements: [...this.card.elements] })
  }
}

/** Start a new card builder. */
export const newCard = (): CardBuilder => new CardBuilder()
