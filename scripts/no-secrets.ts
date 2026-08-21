/**
 * High-confidence credential patterns for the staged-content secret gate.
 * Pattern list intentionally stays conservative: prefixes and fixed-width
 * character runs that real provider credentials carry and ordinary prose,
 * identifiers, and short placeholders do not. The ceiling is low-entropy or
 * unprefixed secrets (e.g. Feishu app secrets, AWS secret access keys), which
 * regex scanning cannot recognize without false positives; the upgrade path
 * is gitleaks for entropy-based and full-history scanning.
 */

/** One credential match reported by {@link scanContentForSecrets}. */
export interface SecretFinding {
  /** Stable pattern name used in diagnostics. */
  pattern: string
  /** One-based line of the match. */
  line: number
}

interface SecretPattern {
  readonly name: string
  readonly regex: RegExp
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-pat-classic', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github-pat-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'openai-deepseek-api-key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'slack-token', regex: /\bxox[bapr]-[0-9A-Za-z-]{10,}\b/ },
]

/**
 * Whether a repository-relative path is outside the secret gate's scope.
 *
 * @param path - Repository-relative path with `/` separators.
 * @returns Whether to skip the path entirely (vendored upstream sources).
 */
export function isSecretScanExcluded(path: string): boolean {
  return path === 'vendor' || path.startsWith('vendor/')
}

/** Line-level escape hatch: a line containing this marker is not scanned. */
const SECRET_ALLOW_MARKER = 'no-secrets: allow'

/**
 * Scan UTF-8 text for embedded credentials.
 *
 * @param content - Decoded file content.
 * @returns One finding per pattern that matched (line of the first match).
 */
export function scanContentForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = content.split('\n')
  for (const { name, regex } of SECRET_PATTERNS) {
    for (const [index, line] of lines.entries()) {
      if (line.includes(SECRET_ALLOW_MARKER)) continue
      if (regex.test(line)) {
        findings.push({ pattern: name, line: index + 1 })
        break
      }
    }
  }
  return findings
}
