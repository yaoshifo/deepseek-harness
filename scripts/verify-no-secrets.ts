/**
 * Pre-commit secret gate: reject staged content that matches high-confidence
 * credential patterns. Reads exact index bytes (`--cached <paths...>`, the
 * lefthook invocation) so a secret edited out of the working tree but still
 * staged is still caught. Exit codes mirror verify-translation-pairing: 1 for
 * a violation, 2 for a usage error.
 * See `scripts/no-secrets.ts` for the pattern list and its ceiling.
 */

import { scanContentForSecrets, isSecretScanExcluded } from './no-secrets.ts'
import { readGitIndexBlob } from './translation-pairing-git.ts'

const args = process.argv.slice(2)
if (args[0] !== '--cached' || args.length < 2) {
  console.error('verify-no-secrets: usage: verify-no-secrets.ts --cached <path...>')
  process.exit(2)
}
const root = process.cwd()
const decoder = new TextDecoder('utf-8', { fatal: true })

let blocked = false
for (const file of args.slice(1)) {
  if (isSecretScanExcluded(file)) continue
  const blob = readGitIndexBlob(root, file)
  if (blob === undefined) continue
  let content: string
  try {
    content = decoder.decode(blob.content)
  } catch {
    continue
  }
  for (const finding of scanContentForSecrets(content)) {
    console.error(`verify-no-secrets: ${file}:${finding.line}: staged content matches the ${finding.pattern} pattern; rotate the credential if it is real, then unstage`)
    blocked = true
  }
}
process.exit(blocked ? 1 : 0)
