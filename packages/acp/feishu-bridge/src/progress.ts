/**
 * Todo-list tool-input parsing shared by the engine's pinned todo section and
 * the streaming preview card: the item model plus the tool-name predicate that
 * recognizes a todo call.
 *
 * @module dsh-feishu-bridge/progress
 */

/** One todo item from a TodoWrite tool input. */
export interface TodoItem {
  id?: string
  content: string
  /** "completed", "in_progress", or "pending". */
  status: string
  activeForm?: string
  description?: string
}

/**
 * Whether a tool name is the todo-list tool: dsh `todo_write` or the
 * Claude-style `TodoWrite`.
 *
 * @param name - Invoked tool name.
 * @returns True when the tool's input carries a todo list.
 */
export function isTodoToolName(name: string): boolean {
  return name.trim().toLowerCase().replaceAll('_', '') === 'todowrite'
}

/**
 * Parse a todo-list tool input into card todo items.
 *
 * @param text - Raw tool input JSON: `{todos: [{content, status, activeForm?}]}`.
 * @returns Parsed items — empty when the list is empty (clears the section);
 *   undefined when the input is not shaped like a todo call (keeps the last list).
 */
export function parseTodoItems(text: string): TodoItem[] | undefined {
  let input: { todos?: Array<{ content?: string; status?: string; activeForm?: string }> }
  try {
    input = JSON.parse(text) as typeof input
  } catch {
    return undefined
  }
  if (!Array.isArray(input.todos)) return undefined
  const out: TodoItem[] = []
  for (const todo of input.todos) {
    const content = (todo.content ?? '').trim()
    if (content === '') continue
    const item: TodoItem = { content, status: (todo.status ?? '').trim() }
    const activeForm = (todo.activeForm ?? '').trim()
    if (activeForm !== '') item.activeForm = activeForm
    out.push(item)
  }
  return out
}
