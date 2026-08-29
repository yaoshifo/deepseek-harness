/** Recorded ACP protocol behavior through the shipped `dsh --profile acp` interface. */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  parseSnapshotManifest,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'
import { claudeProjectSlug } from '@deepseek-ai/dsh-memory'

const corpusDir = fileURLToPath(new URL('./', import.meta.url))

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const controllerCases: readonly {
  readonly name: string
  readonly hasModelTurn: boolean
  readonly configPath?: string
}[] = [
  { name: 'handshake', hasModelTurn: false },
  { name: 'reject-extra-dirs', hasModelTurn: false },
  { name: 'cancel', hasModelTurn: true },
  { name: 'cancel-tool-calls', hasModelTurn: true },
  { name: 'escalation-approved', hasModelTurn: true },
  { name: 'escalation-rejected', hasModelTurn: true },
  { name: 'fs-escalation-approved', hasModelTurn: true },
  {
    name: 'image-compaction',
    hasModelTurn: true,
    configPath: join(corpusDir, 'image-compaction', 'cordis.yml'),
  },
  // Fork-local scenarios ported from the retired examples/acp-agent suite.
  // dsh-memory: recall-and-write round trip over the Claude Code memory layout;
  // the workspace seed below cannot be a committed workspace/ fixture because
  // the project slug derives from the run's dynamic temp cwd.
  {
    name: 'dsh-memory',
    hasModelTurn: true,
    configPath: join(corpusDir, 'dsh-memory', 'cordis.yml'),
  },
  // lsp-symbol: workspaceSymbol over the deterministic stdio fixture server.
  {
    name: 'lsp-symbol',
    hasModelTurn: true,
    configPath: join(corpusDir, 'lsp-symbol', 'cordis.yml'),
  },
  // ask-question-multi-select-variant: the model emits the camelCase
  // multiSelect key, the input boundary normalizes it, and the deterministic
  // auto-answer provider settles the card end to end.
  {
    name: 'ask-question-multi-select-variant',
    hasModelTurn: true,
    configPath: join(corpusDir, 'ask-question-multi-select-variant', 'cordis.yml'),
  },
] as const

function localScenarioSource(source: string | undefined): string | undefined {
  return source?.includes('/') === false ? source : undefined
}

const scenarios: Scenario[] = controllerCases.map((controller) => {
  const manifestPath = join(corpusDir, controller.name, 'snapshot.yml')
  const manifest = parseSnapshotManifest(readFileSync(manifestPath, 'utf8'), manifestPath)
  if (manifest.recording === undefined || manifest.header === undefined) {
    throw new Error(`${controller.name}: ACP snapshot manifest lacks recording or header metadata`)
  }
  const systemPromptSource = localScenarioSource(manifest.header.systemPromptSource)
  const toolSchemasSource = localScenarioSource(manifest.header.toolSchemasSource)
  return {
    ...controller,
    recorded: manifest.recording === 'live',
    ...(manifest.replay?.override === true ? { overridden: true } : {}),
    ...(manifest.header.pin === true ? { pinsHeader: true } : {}),
    ...(manifest.header.changes === undefined ? {} : { expectedHeaderChanges: manifest.header.changes }),
    headerClass: manifest.header.class,
    ...(systemPromptSource === undefined ? {} : { systemPromptSource }),
    ...(toolSchemasSource === undefined ? {} : { toolSchemasSource }),
    ...(manifest.platform === 'posix' ? { posixOnly: true } : {}),
    ...(manifest.platform === 'pwsh' ? { pwshOnly: true } : {}),
    ...(controller.configPath === undefined ? {} : { configPath: controller.configPath }),
    ...manifest.permission === undefined && manifest.environment === undefined
      ? {}
      : {
          env: {
            ...manifest.environment,
            ...(manifest.permission === undefined ? {} : { DSH_PERMISSION_MODE: manifest.permission }),
          },
        },
  }
})

// Claude Code memory scenario seed: pre-seed the shared memory directory for
// this run's dynamic temp cwd (slug derived at runtime), so the session-start
// injection recalls real files and tool writes land inside the workspace. The
// global scope seeds <cwd>/.claude/memory so its index is recalled first and
// scope=global tool writes land there.
async function prepareDshMemoryWorkspace(cwd: string): Promise<void> {
  const memoryDir = join(cwd, '.claude', 'projects', claudeProjectSlug(cwd), 'memory')
  const globalDir = join(cwd, '.claude', 'memory')
  await mkdir(memoryDir, { recursive: true })
  await mkdir(globalDir, { recursive: true })
  await Promise.all([
    writeFile(
      join(memoryDir, 'MEMORY.md'),
      '# Memory Index\n\n- [Deployment tool](reference-deploy-tool.md) — deploy scripts run through pnpm\n',
    ),
    writeFile(
      join(memoryDir, 'reference-deploy-tool.md'),
      '---\nname: reference-deploy-tool\ndescription: Deployment tooling pointers for this project\nmetadata:\n  type: reference\n---\nDeploy entry: `scripts/deploy.sh`.\n',
    ),
    writeFile(
      join(globalDir, 'MEMORY.md'),
      '# Memory Index\n\n- [Keychain sandbox pit](feedback-keychain-sandbox.md) — daemon git push token-invalid is a sandbox false alarm\n',
    ),
    writeFile(
      join(globalDir, 'feedback-keychain-sandbox.md'),
      '---\nname: feedback-keychain-sandbox\ndescription: daemon git push reporting token invalid is usually the sandbox blocking the keychain\nmetadata:\n  type: feedback\n---\nRetry with escalated sandbox access before diagnosing credentials.\n',
    ),
  ])
}

// Manifests cannot express a prepare hook; the memory seed attaches here
// because its path derives from the run's temp cwd.
for (const scenario of scenarios) {
  if (scenario.name === 'dsh-memory') scenario.prepareWorkspace = prepareDshMemoryWorkspace
}

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('./escalation-approved/cordis.yml', import.meta.url)),
    profile: 'acp',
    tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: corpusDir,
  scenarios,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
