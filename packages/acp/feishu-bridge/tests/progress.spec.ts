/**
 * Todo-list tool-input parsing (src/progress.ts): the tool-name predicate and
 * the item parser shared by the engine's pinned todo section and the streaming
 * preview card.
 *
 * @module dsh-feishu-bridge/tests-progress
 */

import { describe, expect, it } from 'vitest'
import { isTodoToolName, parseTodoItems } from '../src/progress.ts'

describe('isTodoToolName', () => {
  it('matches dsh todo_write and Claude-style TodoWrite', () => {
    expect(isTodoToolName('todo_write')).toBe(true)
    expect(isTodoToolName('TodoWrite')).toBe(true)
    expect(isTodoToolName('  todowrite ')).toBe(true)
  })

  it('rejects other tool names', () => {
    expect(isTodoToolName('bash')).toBe(false)
    expect(isTodoToolName('todo_write_extra')).toBe(false)
    expect(isTodoToolName('')).toBe(false)
  })
})

describe('parseTodoItems', () => {
  it('parses a todo_write input into TodoItem[]', () => {
    const items = parseTodoItems('{"todos":[{"content":"step one","status":"in_progress"},{"content":"step two","status":"pending"}]}')
    expect(items).toEqual([
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
  })

  it('keeps a trimmed activeForm and drops entries without content', () => {
    const items = parseTodoItems('{"todos":[{"content":"   ","status":"pending"},{"content":" step ","status":" pending ","activeForm":" doing "}]}')
    expect(items).toEqual([{ content: 'step', status: 'pending', activeForm: 'doing' }])
  })

  it('returns an empty list for an empty todos array', () => {
    expect(parseTodoItems('{"todos":[]}')).toEqual([])
  })

  it('returns undefined for malformed JSON or a non-todo shape', () => {
    expect(parseTodoItems('not json')).toBeUndefined()
    expect(parseTodoItems('{"other":1}')).toBeUndefined()
  })
})
