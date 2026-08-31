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
  /** Live-state header icon (uploaded image key); empty string or omitted renders none. */
  icon?: string
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
  /** Row text; markdown content the caller owns — unstyled text renders as the bold row label on Feishu. */
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
  /** Initial checked state; capable checkers render the box pre-ticked. */
  checked?: boolean
}

/** Renders checkboxes for multi-select questions (Feishu checker inside a form). */
export interface CardCheckOptions {
  kind: 'checkOptions'
  question?: string
  options: CardCheckOption[]
  /** Form submit action, e.g. "askq_multi:0". */
  action?: string
  extra?: Record<string, string>
  /**
   * Free-text input rendered inside the checker form; its value rides the
   * same submit as the checked options. Absent on checkers without a text
   * channel (e.g. delete-mode pickers).
   */
  textInput?: { name: string; placeholder: string }
  /**
   * Submit-button label overriding the generic 提交选择 — ask cards scope it
   * to its question (提交第 N 题) so it cannot read as a whole-card submit.
   */
  submitLabel?: string
}

/** Renders an image by platform-specific image key (e.g. a Feishu image_key). */
export interface CardImage {
  kind: 'image'
  imageKey: string
  alt?: string
  /** Empty = platform default (crop_center); "fit_horizontal" = full image, no cropping, width fills card. */
  scaleType?: string
}

/**
 * Opaque VChart spec of a chart element: rendered verbatim into the Feishu
 * card's `chart_spec` and never interpreted by the bridge. Field names and
 * semantics are owned by VChart (`type`, `data`, `xField`, `yField`, …).
 * Feishu validates the spec server-side at send time (code 230099 rejects
 * an invalid one), so callers own spec correctness — e.g. `color` needs a
 * complete `{ type: 'ordinal', domain, range }` scale.
 */
export type VChartSpec = Record<string, unknown>

/**
 * Renders a Feishu-native chart (schema 2.0 "chart" tag, VChart engine);
 * bridge-native, no cc-connect counterpart. Feishu applies its defaults for
 * `color_theme` and `preview` (theme brand, preview on).
 */
export interface CardChart {
  kind: 'chart'
  /** Opaque VChart spec, passed through to Feishu untouched. */
  spec: VChartSpec
  /**
   * Chart width/height ratio; omitted rides the Feishu defaults (PC 16:9,
   * mobile 1:1). Only the four ratios the chart component documents.
   */
  aspectRatio?: '1:1' | '2:1' | '4:3' | '16:9'
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
  | CardChart
  | CardCollapsiblePanel
  | CardForm
  | CardInput
  | CardColumnSet

/**
 * Shorthand constructor for a plain button.
 * @param text - Display text on the button.
 * @param type - Button style: "primary", "default", or "danger".
 * @param value - Callback data returned when clicked.
 * @returns The assembled button.
 */
export const btn = (text: string, type: string, value: string): CardButton => ({ text, type, value })

/**
 * Shorthand constructor for a primary-styled button.
 * @param text - Display text on the button.
 * @param value - Callback data returned when clicked.
 * @returns The assembled primary button.
 */
export const primaryBtn = (text: string, value: string): CardButton => ({ text, type: 'primary', value })

/**
 * Shorthand constructor for a default-styled button.
 * @param text - Display text on the button.
 * @param value - Callback data returned when clicked.
 * @returns The assembled default button.
 */
export const defaultBtn = (text: string, value: string): CardButton => ({ text, type: 'default', value })

/**
 * Shorthand constructor for a danger-styled button.
 * @param text - Display text on the button.
 * @param value - Callback data returned when clicked.
 * @returns The assembled danger button.
 */
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
    const cur = elements[i]
    // Direct panel (schema 2.0 forbids submit-less form wrappers)…
    if (cur?.kind === 'collapsiblePanel') {
      const panel: CardCollapsiblePanel = { ...cur, elements: [...cur.elements, el] }
      return elements.map((e, idx) => (idx === i ? panel : e))
    }
    // …or a legacy form-wrapped panel (Go kept the form for form_submit hints).
    if (cur?.kind === 'form') {
      for (const [j, fe] of cur.elements.entries()) {
        if (fe.kind === 'collapsiblePanel') {
          const panel: CardCollapsiblePanel = { ...fe, elements: [...fe.elements, el] }
          const updatedForm: CardForm = {
            ...cur,
            elements: cur.elements.map((e, idx) => (idx === j ? panel : e)),
          }
          return elements.map((e, idx) => (idx === i ? updatedForm : e))
        }
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
  /** Optional colored title bar rendered above the elements. */
  header?: CardHeader
  /** Ordered card content elements. */
  elements: CardElement[] = []
  /** Metadata cached by platforms for callback card replacement. */
  permBody?: string

  /**
   * Convert the card to plain text for platforms without rich-card support.
   * @returns The markdown-flavored plain-text rendering.
   */
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
          if (elem.textInput !== undefined) {
            sb += `[${elem.textInput.placeholder}]\n`
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
          // collapsiblePanel / columnSet have no text degradation (mirrors
          // Go); chart likewise — platforms without the component drop it.
          break
      }
    }

    return sb.replace(/\n+$/, '')
  }

  /**
   * Whether the card contains interactive elements. Top level only — a
   * button inside a collapsible panel does not count, mirroring Go.
   * @returns True when any top-level element is interactive.
   */
  hasButtons(): boolean {
    return this.elements.some(e =>
      e.kind === 'actions' || e.kind === 'listItem' || e.kind === 'select' || e.kind === 'checkOptions' || e.kind === 'form')
  }

  /**
   * Extract all buttons as rows (one row per actions element; list items
   * become single-button rows), walking into forms and collapsible panels.
   * @returns Button rows in element order, each row holding its buttons' text and callback data.
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

  /**
   * Set the card header with a title and color.
   * @param title - Header title text.
   * @param color - Header color name (e.g. "blue", "green").
   * @returns This builder, for chaining.
   */
  title(title: string, color: string): this {
    this.card.header = { title, color }
    return this
  }

  /**
   * Attach a live-state icon to the header (uploaded image key).
   * @param icon - Image key of the header icon; empty string removes it.
   * @returns This builder, for chaining.
   */
  icon(icon: string): this {
    if (this.card.header === undefined) return this
    if (icon === '') delete this.card.header.icon
    else this.card.header.icon = icon
    return this
  }

  /**
   * Append a markdown text element; empty content is skipped.
   * @param content - Markdown source text.
   * @returns This builder, for chaining.
   */
  markdown(content: string): this {
    if (content !== '') {
      this.card.elements.push({ kind: 'markdown', content })
    }
    return this
  }

  /**
   * Append a Go-style formatted markdown text element.
   * @param format - sprintf-style format string.
   * @param args - Values substituted into the format placeholders.
   * @returns This builder, for chaining.
   */
  markdownf(format: string, ...args: unknown[]): this {
    return this.markdown(sprintf(format, ...args))
  }

  /**
   * Append a horizontal divider.
   * @returns This builder, for chaining.
   */
  divider(): this {
    this.card.elements.push({ kind: 'divider' })
    return this
  }

  /**
   * Append an action row with the given buttons; empty rows are skipped.
   * @param buttons - Buttons forming the row.
   * @returns This builder, for chaining.
   */
  buttons(...buttons: CardButton[]): this {
    if (buttons.length > 0) {
      this.card.elements.push({ kind: 'actions', buttons, layout: 'row' })
    }
    return this
  }

  /**
   * Append an action row where each button takes equal width on platforms with richer layouts.
   * @param buttons - Buttons forming the row.
   * @returns This builder, for chaining.
   */
  buttonsEqual(...buttons: CardButton[]): this {
    if (buttons.length > 0) {
      this.card.elements.push({ kind: 'actions', buttons, layout: 'equal_columns' })
    }
    return this
  }

  /**
   * Append a list row: description on the left, default-styled button on the right.
   * @param desc - Row description text.
   * @param btnText - Display text on the row's button.
   * @param btnValue - Callback data for the row's button.
   * @returns This builder, for chaining.
   */
  listItem(desc: string, btnText: string, btnValue: string): this {
    this.card.elements.push({ kind: 'listItem', text: desc, btnText, btnType: 'default', btnValue })
    return this
  }

  /**
   * Like {@link CardBuilder.listItem} with an explicit button type.
   * @param desc - Row description text.
   * @param btnText - Display text on the row's button.
   * @param btnType - Row button style: "primary", "default", or "danger".
   * @param btnValue - Callback data for the row's button.
   * @returns This builder, for chaining.
   */
  listItemBtn(desc: string, btnText: string, btnType: string, btnValue: string): this {
    this.card.elements.push({ kind: 'listItem', text: desc, btnText, btnType, btnValue })
    return this
  }

  /**
   * Like {@link CardBuilder.listItemBtn} with extra callback data.
   * @param label - Bold row text.
   * @param description - Optional secondary text under the label.
   * @param btnText - Display text on the row's button.
   * @param btnType - Row button style: "primary", "default", or "danger".
   * @param btnValue - Callback data for the row's button.
   * @param extra - Additional key-value pairs carried in the button callback.
   * @returns This builder, for chaining.
   */
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

  /**
   * Append a list row whose button opens a URL directly.
   * @param text - Row description text.
   * @param btnText - Display text on the row's button.
   * @param btnType - Row button style: "primary", "default", or "danger".
   * @param btnURL - URL the button opens (no callback).
   * @returns This builder, for chaining.
   */
  listItemURL(text: string, btnText: string, btnType: string, btnURL: string): this {
    this.card.elements.push({ kind: 'listItem', text, btnText, btnType, btnValue: '', btnUrl: btnURL })
    return this
  }

  /**
   * Append a list row with a URL (jump) button plus a second callback button, which may render disabled.
   * @param text - Row description text.
   * @param btnText - Display text on the URL button.
   * @param btnType - URL button style: "primary", "default", or "danger".
   * @param btnURL - URL the first button opens (no callback).
   * @param btn2Text - Display text on the second, callback button.
   * @param btn2Type - Second button style: "primary", "default", or "danger".
   * @param btn2Value - Callback data for the second button.
   * @param btn2Disabled - When true, the second button renders disabled and carries no callback value.
   * @param btn2Tip - Tooltip shown while the second button is disabled.
   * @returns This builder, for chaining.
   */
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

  /**
   * Append a dropdown selector; empty option lists are skipped.
   * @param placeholder - Placeholder text shown before a choice is made.
   * @param options - Dropdown items.
   * @param initValue - Pre-selected option value (empty = none).
   * @returns This builder, for chaining.
   */
  select(placeholder: string, options: CardSelectOption[], initValue: string): this {
    if (options.length > 0) {
      this.card.elements.push({ kind: 'select', placeholder, options, initValue })
    }
    return this
  }

  /**
   * Append a multi-select checkbox element; empty option lists are skipped.
   * @param question - Question text rendered above the checkboxes (empty = none).
   * @param options - Checkbox items.
   * @param action - Form submit action carried by the submit button's callback.
   * @param extra - Additional key-value pairs carried in the submit callback.
   * @returns This builder, for chaining.
   */
  checkOptions(question: string, options: CardCheckOption[], action: string, extra?: Record<string, string>): this {
    if (options.length > 0) {
      this.card.elements.push(extra === undefined
        ? { kind: 'checkOptions', question, options, action }
        : { kind: 'checkOptions', question, options, action, extra })
    }
    return this
  }

  /**
   * Append a footnote element; empty text is skipped.
   * @param text - Footnote text.
   * @returns This builder, for chaining.
   */
  note(text: string): this {
    if (text !== '') {
      this.card.elements.push({ kind: 'note', text })
    }
    return this
  }

  /**
   * Append a tagged footnote element (machine-readable tag); empty text is skipped.
   * @param tag - Machine-readable identifier, not displayed.
   * @param text - Footnote text.
   * @returns This builder, for chaining.
   */
  taggedNote(tag: string, text: string): this {
    if (text !== '') {
      this.card.elements.push({ kind: 'note', text, tag })
    }
    return this
  }

  /**
   * Append an image element; empty image keys are skipped.
   * @param imageKey - Platform-specific image key (e.g. a Feishu image_key).
   * @param alt - Alt text shown when the image fails to load.
   * @returns This builder, for chaining.
   */
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
   * @param imageKey - Platform-specific image key (e.g. a Feishu image_key).
   * @param alt - Alt text shown when the image fails to load.
   * @returns This builder, for chaining.
   */
  imageFill(imageKey: string, alt: string): this {
    if (imageKey !== '') {
      this.card.elements.push({ kind: 'image', imageKey, alt, scaleType: 'fit_horizontal' })
    }
    return this
  }

  /**
   * Append a Feishu-native chart element (schema 2.0 "chart" tag, VChart engine).
   * @param spec - Opaque VChart spec, passed through to Feishu verbatim.
   * @param options - `aspectRatio` overrides the Feishu default (PC 16:9,
   *   mobile 1:1) when present.
   * @returns This builder, for chaining.
   */
  chart(spec: VChartSpec, options?: { aspectRatio?: CardChart['aspectRatio'] }): this {
    // Conditional push, not a spread: exactOptionalPropertyTypes forbids
    // assigning an explicit `undefined` to the optional field.
    this.card.elements.push(
      options?.aspectRatio ? { kind: 'chart', spec, aspectRatio: options.aspectRatio } : { kind: 'chart', spec },
    )
    return this
  }

  /**
   * Append a collapsible panel; empty element lists are skipped.
   * @param title - Panel header title.
   * @param expanded - Initial expansion state.
   * @param elements - Panel content elements.
   * @returns This builder, for chaining.
   */
  collapsiblePanel(title: string, expanded: boolean, ...elements: CardElement[]): this {
    if (elements.length > 0) {
      this.card.elements.push({ kind: 'collapsiblePanel', title, expanded, elements })
    }
    return this
  }

  /**
   * Append a form container; empty element lists are skipped.
   * @param name - Form component name (required by Feishu).
   * @param elements - Form content elements (inputs, submit buttons, etc.).
   * @returns This builder, for chaining.
   */
  form(name: string, ...elements: CardElement[]): this {
    if (elements.length > 0) {
      this.card.elements.push({ kind: 'form', name, elements })
    }
    return this
  }

  /**
   * Append pre-built elements verbatim (composed cards like the completion footer).
   * @param elements - Elements to append as-is.
   * @returns This builder, for chaining.
   */
  raw(...elements: CardElement[]): this {
    this.card.elements.push(...elements)
    return this
  }

  /**
   * Return the constructed card.
   * @returns The assembled card.
   */
  build(): Card {
    return Object.assign(new Card(), { header: this.card.header, elements: [...this.card.elements] })
  }
}

/**
 * Start a new card builder.
 * @returns A fresh builder with an empty card.
 */
export const newCard = (): CardBuilder => new CardBuilder()
