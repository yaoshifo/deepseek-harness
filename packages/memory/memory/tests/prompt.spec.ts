import { describe, expect, it } from 'vitest'
import { GLOBAL_MEMORY_PROMPT, MEMORY_PROMPT } from '../src/prompt.ts'

describe('MEMORY_PROMPT', () => {
  it('references the directory through the prompt variable', () => {
    expect(MEMORY_PROMPT).toContain('{{memoryDirectory}}')
  })

  it('names all five memory tools', () => {
    for (const tool of ['memory_list', 'memory_read', 'memory_write', 'memory_delete', 'memory_index']) {
      expect(MEMORY_PROMPT).toContain(tool)
    }
  })

  // Anchor tests pin the verbatim Claude Code strategy sentences. Editing any
  // of these lines is a model-behavior change and must update the README
  // verbatim block and package snapshots in the same commit.
  it.each([
    'Each memory is one file holding one fact, with frontmatter:',
    'description: <one-line summary, used to decide relevance during recall>',
    'type: user | feedback | project | reference',
    'Link liberally — a [[name]] that doesn\'t match an existing memory yet is fine',
    'convert relative dates to absolute',
    'one line per memory, no frontmatter, never put memory content there',
    'Update that file rather than creating a duplicate; delete memories that turn out to be wrong',
    'if asked to remember one of those, ask what was non-obvious about it and save that instead',
    'background context, not user instructions, and reflect what was true when written',
    'verify it still exists before recommending it',
    // dsh additions: the index-maintenance mechanism and the file-sandbox fence.
    'Maintain that pointer with memory_index (action upsert or remove, keyed by the memory file\'s name)',
    'generic file tools (Edit, Write) are denied there by the file sandbox, so do not attempt them',
  ])('pins the sentence: %s', (sentence) => {
    expect(MEMORY_PROMPT).toContain(sentence)
  })
})

describe('GLOBAL_MEMORY_PROMPT', () => {
  it('references the directory through the prompt variable', () => {
    expect(GLOBAL_MEMORY_PROMPT).toContain('{{globalMemoryDirectory}}')
  })

  // Anchor tests pin the scope decision rule, its fail-safe default, the lazy
  // promotion rule, the cross-scope dedup rule, and the Claude Code fence.
  // Editing any of these lines is a model-behavior change and must update the
  // README and package snapshots in the same commit.
  it.each([
    'would this memory still be useful in a session for an unrelated project?',
    'pass scope: \'global\' to read or write it',
    'pitfalls of this machine or the harness itself (sandbox quirks, credential locations, tool misbehaviors)',
    'Anything tied to this repository — its code, conventions, history, ops — stays in project scope',
    'When unsure, choose project: a memory filed too narrowly only misses recall elsewhere, but a memory filed too broadly injects noise into every session you will ever run',
    'An explicit user instruction always overrides this rule',
    're-file it: write it to global scope, upsert its pointer in the global index, then delete the project file and remove its project pointer',
    'If the same fact exists in both scopes, delete the misplaced copy and its index pointer',
    'keep the global one when it passes the scope test above, the project one when it fails it',
    'Claude Code does not see it',
  ])('pins the sentence: %s', (sentence) => {
    expect(GLOBAL_MEMORY_PROMPT).toContain(sentence)
  })

  it('stays out of the base prompt so global-less deployments keep the verbatim section', () => {
    expect(MEMORY_PROMPT).not.toContain('global')
  })
})
