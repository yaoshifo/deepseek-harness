/**
 * Chatroom role-directory loading ported from cc-connect
 * core/chatroom_roles.go: one persona subdirectory per role (each with its
 * own CLAUDE.md). The default root lives under the Claude config home so a
 * role's project memory (derived from the workdir path) accumulates there too.
 *
 * @module dsh-feishu-bridge/chatroom-roles
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Claude config home: $CLAUDE_CONFIG_DIR, else ~/.claude (Go ClaudeConfigHomeDir). */
export function claudeConfigHomeDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR
  if (env !== undefined && env.trim() !== '') return env
  return join(homedir(), '.claude')
}

/** Default root holding one persona subdirectory per role. */
export function defaultChatroomRolesDir(): string {
  return join(claudeConfigHomeDir(), 'chatroom-roles')
}

/**
 * Reject names that could escape the roles root (path traversal) or contain
 * path separators — a role name is a single directory segment.
 */
export function validRoleName(name: string): Error | undefined {
  const n = name.trim()
  if (n === '') return new Error('role name is empty')
  if (n.includes('/') || n.includes('\\') || n === '.' || n === '..' || n.includes('..')) {
    return new Error(`invalid role name "${n}" (must be a single path segment)`)
  }
  return undefined
}

/** Absolute directory for a role under rolesDir. */
export function roleDir(rolesDir: string, name: string): string {
  return join(rolesDir, name.trim())
}

/** The persona file the agent loads natively. */
export function roleCLAUDEMD(rolesDir: string, name: string): string {
  return join(roleDir(rolesDir, name), 'CLAUDE.md')
}

/** Whether the role has a CLAUDE.md persona file. */
export function roleExists(rolesDir: string, name: string): boolean {
  if (validRoleName(name) !== undefined) return false
  try {
    return !statSync(roleCLAUDEMD(rolesDir, name)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Enumerate roles under rolesDir (subdirectories that contain a CLAUDE.md).
 * A missing rolesDir yields an empty list — no error path for callers.
 */
export function listRoleNames(rolesDir: string): string[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(rolesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    try {
      statSync(join(rolesDir, ent.name, 'CLAUDE.md'))
      names.push(ent.name)
    } catch {
      // Subdirectory without a CLAUDE.md persona — not a role.
    }
  }
  return names
}

/**
 * The bold "root mental model" phrase from a role's ESSENCE.md, or '' when
 * the file is missing or does not follow the gen-thinker-role format.
 * Ceiling: hand-written or legacy variants (e.g. `总纲 = …`) return '' and
 * the caller shows the name only; upgrade path is a dedicated BLURB.md.
 */
export function roleEssence(rolesDir: string, name: string): string {
  let data: string
  try {
    data = readFileSync(join(rolesDir, name, 'ESSENCE.md'), 'utf8')
  } catch {
    return ''
  }
  const m = /根心智模型\s*=\s*\*\*([^*]+)\*\*/.exec(data)
  if (m === null || m[1] === undefined) return ''
  return m[1].trim()
}
