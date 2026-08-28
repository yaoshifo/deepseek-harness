/**
 * Feishu interactive card renderer ported from cc-connect platform/feishu
 * card.go + card_baseline.go + delete_mode_form.go: renders the core Card
 * model into schema 2.0 JSON maps (renderElement family), applies the compact
 * body baseline, and transforms delete-mode list cards into checker forms.
 *
 * @module dsh-feishu-bridge/feishu-card
 */

import type { Card, CardElement } from '../card.js'
import { finalizeFeishuCardMarkdown } from './markdown.js'

/** Rendered Feishu card element/card structure (Go map[string]any). */
export type FeishuCardMap = Record<string, unknown>

/**
 * 卡片紧凑基线（cc-connect 的 card_style_guide）：body/header padding 统一
 * "4px 12px 4px 12px"，body vertical_spacing 统一 "0px"。所有 body/header
 * 构造都必须走这两个常量，避免渲染路径漂移。
 */
export const cardBodyPadding = '4px 12px 4px 12px'
/** Body vertical spacing in the compact baseline. */
export const cardBodyVerticalSpacing = '0px'
/** Header padding in the compact baseline. */
export const cardHeaderPadding = '4px 12px 4px 12px'

/**
 * Card body structure carrying the compact baseline.
 * @param elements - Rendered body element maps.
 * @returns The body map with compact padding and vertical spacing applied.
 */
export function compactCardBody(elements: FeishuCardMap[]): FeishuCardMap {
  return {
    padding: cardBodyPadding,
    vertical_spacing: cardBodyVerticalSpacing,
    elements,
  }
}

function plainText(content: string): FeishuCardMap {
  return { tag: 'plain_text', content }
}

/**
 * Render a single CardElement into a Feishu card element map; unhandled kinds return undefined.
 * @param elem - Core card element to render.
 * @param sessionKey - Session key stamped into button callback values (empty = omitted).
 * @returns The schema 2.0 element map, or undefined when the kind has no Feishu rendering.
 */
export function renderElement(elem: CardElement, sessionKey: string): FeishuCardMap | undefined {
  switch (elem.kind) {
    case 'markdown':
      return {
        tag: 'markdown',
        content: finalizeFeishuCardMarkdown(elem.content),
      }
    case 'divider':
      return { tag: 'hr' }
    case 'actions': {
      const actions: FeishuCardMap[] = []
      for (const btnEl of elem.buttons) {
        const btnType = btnEl.type === '' ? 'default' : btnEl.type
        const action: FeishuCardMap = {
          size: 'tiny',
          tag: 'button',
          text: plainText(btnEl.text),
          type: btnType,
        }
        if ((btnEl.url ?? '') !== '') {
          action.url = btnEl.url
        } else {
          const valMap: Record<string, string> = { action: btnEl.value }
          if (sessionKey !== '') valMap.session_key = sessionKey
          for (const [k, v] of Object.entries(btnEl.extra ?? {})) valMap[k] = v
          action.value = valMap
        }
        if (btnEl.actionType === 'form_submit') action.form_action_type = 'submit'
        if ((btnEl.name ?? '') !== '') action.name = btnEl.name
        if (elem.layout === 'equal_columns') action.width = 'fill'
        actions.push(action)
      }
      if (actions.length > 0) {
        // Single form_submit button: return directly to avoid nested column_set.
        if (actions.length === 1 && (elem.buttons[0]?.actionType ?? '') === 'form_submit') {
          return actions[0]
        }
        if (elem.layout === 'equal_columns') {
          const columns: FeishuCardMap[] = actions.map(action => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            horizontal_align: 'center',
            elements: [action],
          }))
          const columnSet: FeishuCardMap = { tag: 'column_set', columns }
          if (actions.length === 2) columnSet.flex_mode = 'bisect'
          return columnSet
        }
        // Schema 2.0 does not support the "action" tag in body elements:
        // column_set with auto-width columns achieves the same layout.
        const columns: FeishuCardMap[] = actions.map(action => ({
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [action],
        }))
        // Trailing status column (plan-card render status). text_size/
        // text_color live on the plain_text text object, not the div top
        // level (schema 2.0 rejects them at div level, code 230099).
        if ((elem.note ?? '').trim() !== '') {
          columns.push({
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [{
              tag: 'div',
              text: {
                tag: 'plain_text',
                content: elem.note,
                text_size: 'notation',
                text_color: 'grey',
              },
            }],
          })
        }
        return {
          tag: 'column_set',
          flex_mode: 'none',
          columns,
        }
      }
      return undefined
    }
    case 'listItem': {
      const btnType = elem.btnType === '' ? 'default' : elem.btnType
      // Callers own the row's markdown: text already carrying '**' is passed
      // through verbatim (wrapping it again would nest bold pairs, which the
      // markdown pipeline then mangles into raw asterisks); plain text gets
      // the default bold row label.
      let leftContent = elem.text.includes('**') ? elem.text : `**${elem.text}**`
      if ((elem.description ?? '') !== '') leftContent += `\n${elem.description ?? ''}`
      leftContent = finalizeFeishuCardMarkdown(leftContent)

      const buttonElem: FeishuCardMap = {
        size: 'tiny',
        tag: 'button',
        text: plainText(elem.btnText),
        type: btnType,
      }
      if ((elem.btnUrl ?? '') !== '') {
        buttonElem.url = elem.btnUrl
      } else {
        const valMap: Record<string, string> = { action: elem.btnValue }
        if (sessionKey !== '') valMap.session_key = sessionKey
        for (const [k, v] of Object.entries(elem.extra ?? {})) valMap[k] = v
        buttonElem.value = valMap
      }
      const columns: FeishuCardMap[] = [
        {
          tag: 'column',
          width: 'weighted',
          weight: 5,
          vertical_align: 'center',
          elements: [{ tag: 'markdown', content: leftContent }],
        },
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [buttonElem],
        },
      ]
      if ((elem.btn2Text ?? '') !== '') {
        const btn2Type = (elem.btn2Type ?? '') === '' ? 'default' : elem.btn2Type ?? ''
        const btn2Elem: FeishuCardMap = {
          size: 'tiny',
          tag: 'button',
          text: plainText(elem.btn2Text ?? ''),
          type: btn2Type,
        }
        if (elem.btn2Disabled === true) {
          btn2Elem.disabled = true
          if ((elem.btn2Tip ?? '') !== '') {
            btn2Elem.disabled_tips = { tag: 'plain_text', content: elem.btn2Tip }
          }
        } else {
          const valMap: Record<string, string> = { action: elem.btn2Value ?? '' }
          if (sessionKey !== '') valMap.session_key = sessionKey
          btn2Elem.value = valMap
        }
        columns.push({
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [btn2Elem],
        })
      }
      return {
        tag: 'column_set',
        flex_mode: 'none',
        columns,
      }
    }
    case 'select': {
      const options = elem.options.map(opt => ({ text: plainText(opt.text), value: opt.value }))
      const selectElem: FeishuCardMap = {
        tag: 'select_static',
        placeholder: plainText(elem.placeholder),
        options,
      }
      if (sessionKey !== '') selectElem.value = { session_key: sessionKey }
      if ((elem.initValue ?? '') !== '') selectElem.initial_option = elem.initValue
      // Schema 2.0: select_static is a direct body element, no "action" wrapper.
      return selectElem
    }
    case 'checkOptions': {
      const formElements: FeishuCardMap[] = []
      if ((elem.question ?? '') !== '') {
        formElements.push({ tag: 'markdown', content: `**${elem.question ?? ''}**` })
      }
      elem.options.forEach((opt, i) => {
        let checkContent = `**${opt.label}**`
        if ((opt.description ?? '') !== '') checkContent += `\n${opt.description ?? ''}`
        checkContent = finalizeFeishuCardMarkdown(checkContent)
        formElements.push({
          tag: 'checker',
          name: `askq_opt_${i + 1}`,
          text: { tag: 'lark_md', content: checkContent },
          ...opt.checked === true ? { checked: true } : {},
        })
      })
      const valMap: Record<string, string> = { action: elem.action ?? '' }
      if (sessionKey !== '') valMap.session_key = sessionKey
      for (const [k, v] of Object.entries(elem.extra ?? {})) valMap[k] = v
      formElements.push({
        size: 'tiny',
        tag: 'button',
        text: plainText('提交选择'),
        type: 'primary',
        form_action_type: 'submit',
        name: `askq_multi_submit_${(elem.action ?? '').replace(/^askq_multi:/, '')}`,
        value: valMap,
      })
      return {
        tag: 'form',
        name: `askq_multi_form_${(elem.action ?? '').replaceAll(':', '_')}`,
        elements: formElements,
      }
    }
    case 'note':
      // Schema 2.0: "note" tag is unsupported; render as italic markdown.
      return {
        tag: 'markdown',
        content: `_${elem.text}_`,
      }
    case 'image': {
      const m: FeishuCardMap = {
        tag: 'img',
        img_key: elem.imageKey,
        alt: { tag: 'plain_text', content: elem.alt ?? '' },
      }
      if (elem.scaleType === 'fit_horizontal') {
        // Tall screenshots: full image without cropping, width fills the card.
        // Negative horizontal margin counters the card's 12px body padding
        // for full-bleed (v2 dropped stretch_without_padding).
        m.scale_type = 'fit_horizontal'
        m.margin = '0 -12px'
      } else {
        m.scale_type = 'crop_center'
        m.size = 'stretch'
      }
      return m
    }
    case 'chart':
      // Opaque payload: unlike buttons/selects there is no session-key
      // stamping, and no local validation — Feishu rejects invalid specs
      // server-side at send time (code 230099).
      return { tag: 'chart', chart_spec: elem.spec }
    case 'columnSet': {
      const columns: FeishuCardMap[] = []
      for (const col of elem.columns) {
        const colElements: FeishuCardMap[] = []
        for (const el of col.elements) {
          const rendered = renderElement(el, sessionKey)
          if (rendered !== undefined) colElements.push(rendered)
        }
        const colMap: FeishuCardMap = {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: colElements,
        }
        if (col.width === 'weighted') {
          colMap.width = 'weighted'
          colMap.weight = (col.weight ?? 0) === 0 ? 1 : col.weight
        }
        columns.push(colMap)
      }
      return {
        tag: 'column_set',
        flex_mode: 'none',
        columns,
      }
    }
    case 'form': {
      const formElements: FeishuCardMap[] = []
      for (const el of elem.elements) {
        const rendered = renderElement(el, sessionKey)
        if (rendered !== undefined) formElements.push(rendered)
      }
      return {
        tag: 'form',
        name: elem.name,
        elements: formElements,
      }
    }
    case 'input': {
      const m: FeishuCardMap = {
        tag: 'input',
        name: elem.name,
        placeholder: { tag: 'plain_text', content: elem.placeholder },
      }
      if ((elem.maxLength ?? 0) > 0) m.max_length = elem.maxLength
      return m
    }
    case 'collapsiblePanel': {
      const panelElements: FeishuCardMap[] = []
      for (const el of elem.elements) {
        const rendered = renderElement(el, sessionKey)
        if (rendered !== undefined) panelElements.push(rendered)
      }
      const titleTag = elem.titleIsMD === true ? 'lark_md' : 'plain_text'
      const result: FeishuCardMap = {
        tag: 'collapsible_panel',
        expanded: elem.expanded,
        header: {
          title: { tag: titleTag, content: elem.title },
          vertical_align: 'center',
          icon: {
            tag: 'standard_icon',
            token: 'down-small-ccm_outlined',
            size: '16px 16px',
          },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        padding: '8px',
        elements: panelElements,
      }
      if ((elem.border ?? '') !== '') result.border = { color: elem.border }
      return result
    }
    default:
      return undefined
  }
}

/**
 * Convert a core Card into the Feishu Interactive Card schema 2.0 map.
 * @param card - Card to render; undefined yields the bare schema/config skeleton.
 * @param sessionKey - Session key stamped into interactive elements' callback values.
 * @returns The rendered card map.
 */
export function renderCardMap(card: Card | undefined, sessionKey: string): FeishuCardMap {
  const result: FeishuCardMap = {
    schema: '2.0',
    config: { wide_screen_mode: true },
  }
  if (card === undefined) return result

  if (card.header !== undefined && card.header.title !== '') {
    const color = card.header.color === '' ? 'blue' : card.header.color
    result.header = {
      title: plainText(card.header.title),
      template: color,
      padding: cardHeaderPadding,
    }
  }
  const transformed = renderDeleteModeCheckerCard(card, result)
  if (transformed !== undefined) return transformed

  const elements: FeishuCardMap[] = []
  for (const elem of card.elements) {
    const rendered = renderElement(elem, sessionKey)
    if (rendered !== undefined) elements.push(rendered)
  }
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: ' ' })
  }

  result.body = compactCardBody(elements)
  return result
}

/**
 * Convert a core Card into the Feishu Interactive Card JSON string.
 * @param card - Card to render; undefined yields the bare schema/config skeleton.
 * @param sessionKey - Session key stamped into interactive elements' callback values.
 * @returns The rendered card map as JSON.
 */
export function renderCard(card: Card | undefined, sessionKey: string): string {
  return JSON.stringify(renderCardMap(card, sessionKey))
}

const deleteModeCheckerNamePrefix = 'delete_sel_'

/**
 * Stable checker component name for a delete-mode session row.
 * @param sessionID - Session identifier encoded into the name.
 * @returns The prefixed, hex-encoded checker name.
 */
export function deleteModeCheckerName(sessionID: string): string {
  return deleteModeCheckerNamePrefix + Buffer.from(sessionID, 'utf8').toString('hex')
}

/**
 * Recover the session ID from a delete-mode checker name.
 * @param name - Checker component name produced by {@link deleteModeCheckerName}.
 * @returns The decoded session ID, or undefined when the name is not a checker name.
 */
export function parseDeleteModeCheckerName(name: string): string | undefined {
  if (!name.startsWith(deleteModeCheckerNamePrefix)) return undefined
  const raw = name.slice(deleteModeCheckerNamePrefix.length)
  if (raw === '') return undefined
  const decoded = Buffer.from(raw, 'hex').toString('utf8')
  return decoded
}

function normalizeDeleteModeCheckerText(text: string): string {
  let trimmed = text.trim()
  for (const prefix of ['☑ ▶', '◻ ▶', '▶', '☑', '◻']) {
    if (trimmed.startsWith(prefix)) {
      trimmed = trimmed.slice(prefix.length).trim()
      break
    }
  }
  return trimmed
}

function parseDeleteModeListItemAction(action: string): { id: string; selectable: boolean } | undefined {
  const togglePrefix = 'act:/delete-mode toggle '
  const noopPrefix = 'act:/delete-mode noop '
  if (action.startsWith(togglePrefix)) {
    const id = action.slice(togglePrefix.length).trim()
    return id !== '' ? { id, selectable: true } : undefined
  }
  if (action.startsWith(noopPrefix)) {
    const id = action.slice(noopPrefix.length).trim()
    return id !== '' ? { id, selectable: false } : undefined
  }
  return undefined
}

/**
 * Transform a delete-mode list card (selectable rows + confirm/cancel) into
 * a schema 2.0 checker form; returns undefined when the card is not one.
 */
function renderDeleteModeCheckerCard(card: Card, base: FeishuCardMap): FeishuCardMap | undefined {
  const formRowElements: FeishuCardMap[] = []
  const notes: { text: string; tag?: string }[] = []
  const navRows: { buttons: { text: string; type: string; value: string; extra?: Record<string, string> }[]; layout: string }[] = []
  let submitText = ''
  let cancelText = ''

  for (const elem of card.elements) {
    switch (elem.kind) {
      case 'listItem': {
        const parsed = parseDeleteModeListItemAction(elem.btnValue)
        if (parsed === undefined) return undefined
        const text = normalizeDeleteModeCheckerText(elem.text)
        if (!parsed.selectable) {
          formRowElements.push({ tag: 'markdown', content: `▶ ${text}` })
          continue
        }
        formRowElements.push({
          tag: 'checker',
          name: deleteModeCheckerName(parsed.id),
          checked: elem.text.includes('☑'),
          text: { tag: 'lark_md', content: text },
        })
        break
      }
      case 'note':
        notes.push(elem.tag === undefined ? { text: elem.text } : { text: elem.text, tag: elem.tag })
        break
      case 'actions': {
        const remaining: typeof elem.buttons = []
        for (const btnEl of elem.buttons) {
          if (btnEl.value === 'act:/delete-mode confirm') {
            submitText = btnEl.text
          } else if (btnEl.value === 'act:/delete-mode cancel') {
            cancelText = btnEl.text
          } else {
            remaining.push(btnEl)
          }
        }
        if (remaining.length > 0) navRows.push({ buttons: remaining, layout: elem.layout })
        break
      }
      case 'markdown':
      case 'divider':
      case 'select':
        return undefined
      default:
        break
    }
  }

  if (formRowElements.length === 0 || submitText === '') return undefined

  const elements: FeishuCardMap[] = []
  for (const n of notes) {
    if (n.text === '') continue
    if (n.tag === 'delete-mode-selected-count') continue
    elements.push({ tag: 'markdown', content: `_${n.text}_` })
  }
  const formElements = [...formRowElements]

  const buttonColumns: FeishuCardMap[] = [
    {
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [{
        size: 'tiny',
        tag: 'button',
        text: plainText(submitText),
        type: 'danger',
        name: 'delete_mode_submit',
        form_action_type: 'submit',
        value: { action: 'act:/delete-mode form-submit' },
      }],
    },
  ]
  if (cancelText !== '') {
    buttonColumns.push({
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [{
        size: 'tiny',
        tag: 'button',
        text: plainText(cancelText),
        type: 'default',
        name: 'delete_mode_cancel',
        value: { action: 'act:/delete-mode cancel' },
      }],
    })
  }
  formElements.push({
    tag: 'column_set',
    horizontal_align: 'left',
    columns: buttonColumns,
  })

  elements.push({
    tag: 'form',
    name: 'delete_mode_form',
    elements: formElements,
  })

  for (const row of navRows) {
    const actions: FeishuCardMap[] = []
    for (const btnEl of row.buttons) {
      const btnType = btnEl.type === '' ? 'default' : btnEl.type
      const valMap: Record<string, string> = { action: btnEl.value }
      for (const [k, v] of Object.entries(btnEl.extra ?? {})) valMap[k] = v
      const action: FeishuCardMap = {
        size: 'tiny',
        tag: 'button',
        text: plainText(btnEl.text),
        type: btnType,
        value: valMap,
      }
      if (row.layout === 'equal_columns') action.width = 'fill'
      actions.push(action)
    }
    if (actions.length > 0) {
      if (row.layout === 'equal_columns') {
        const cols: FeishuCardMap[] = actions.map(a => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          horizontal_align: 'center',
          elements: [a],
        }))
        const colSet: FeishuCardMap = { tag: 'column_set', columns: cols }
        if (actions.length === 2) colSet.flex_mode = 'bisect'
        elements.push(colSet)
      } else {
        const cols: FeishuCardMap[] = actions.map(a => ({
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [a],
        }))
        elements.push({ tag: 'column_set', flex_mode: 'none', columns: cols })
      }
    }
  }

  // 走紧凑基线（padding + vertical_spacing），与 renderCardMap 的通用 body 一致。
  base.body = compactCardBody(elements)
  return base
}
