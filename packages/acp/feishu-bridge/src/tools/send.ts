/**
 * The model-facing `feishu_bridge_send` tool: the cc-connect `send` CLI
 * subcommand surface (cmd/cc-connect/send.go) ported to a dsh tool (plan D4).
 * The caller agent resolves its owning Engine + engine session key through
 * the router — the Go CLI's CC_PROJECT/CC_SESSION_KEY env contract, without
 * env — and the tool reads local files into attachments for
 * Engine.sendToSessionWithAttachments, the port of Go SendToSessionWithAttachments.
 *
 * Model-visible outputs are the Go CLI's result sentences verbatim where one
 * exists ("Message sent successfully.", "attachment %s exceeds size limit").
 *
 * @module dsh-feishu-bridge/tools-send
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileAttachment, ImageAttachment } from '../core/types.ts'
import type { SubtaskRoute } from './subtask.ts'

/** Resolves the calling dsh agent to its engine session (shared with the subtask tool). */
export type SendAgentRouter = (agent: unknown) => SubtaskRoute | undefined

/** Attachment size ceiling (Go maxAttachmentSize: 50 MB). */
export const maxAttachmentSize = 50 << 20

const mimeByExtension: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/**
 * Detect an attachment's mime type: extension table first, then a magic-byte
 * sniff of the first bytes (Go detectAttachmentMimeType: mime.TypeByExtension
 * then http.DetectContentType).
 *
 * @param fileName - The attachment's file name.
 * @param data - The attachment bytes.
 * @returns The detected mime type.
 */
export function detectAttachmentMimeType(fileName: string, data: Uint8Array): string {
  const byExt = mimeByExtension[extname(fileName).toLowerCase()]
  if (byExt !== undefined) return byExt
  if (data.length === 0) return 'application/octet-stream'
  const sniff = data.length > 512 ? data.subarray(0, 512) : data
  if (sniff.length >= 4 && sniff[0] === 0x89 && sniff[1] === 0x50 && sniff[2] === 0x4e && sniff[3] === 0x47) {
    return 'image/png'
  }
  if (sniff.length >= 3 && sniff[0] === 0xff && sniff[1] === 0xd8 && sniff[2] === 0xff) {
    return 'image/jpeg'
  }
  if (sniff.length >= 6 && sniff[0] === 0x47 && sniff[1] === 0x49 && sniff[2] === 0x46) {
    return 'image/gif'
  }
  if (sniff.length >= 12 && sniff[0] === 0x52 && sniff[1] === 0x49 && sniff[2] === 0x46 && sniff[3] === 0x46
    && sniff[8] === 0x57 && sniff[9] === 0x45 && sniff[10] === 0x42 && sniff[11] === 0x50) {
    return 'image/webp'
  }
  if (sniff.length >= 4 && sniff[0] === 0x25 && sniff[1] === 0x50 && sniff[2] === 0x44 && sniff[3] === 0x46) {
    return 'application/pdf'
  }
  // Go http.DetectContentType's text sniff: control bytes (minus tab/CR/LF/FF)
  // rule out text.
  let isText = true
  for (const b of sniff) {
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) || b === 0x7f) {
      isText = false
      break
    }
  }
  return isText ? 'text/plain; charset=utf-8' : 'application/octet-stream'
}

/**
 * Read one local file into image/file attachment bytes (Go readAttachment,
 * local-path branch only: the agent's artifacts live on disk; the Go CLI's
 * http(s) fetch is not ported).
 *
 * @param path - Absolute or session-workdir-relative path.
 * @param workDir - The session's effective work dir for relative paths; '' keeps the path as-is.
 * @returns The read attachment.
 */
async function readAttachment(path: string, workDir: string): Promise<ImageAttachment | FileAttachment> {
  const cleaned = isAbsolute(path) ? path : resolve(workDir, path)
  let size: number
  try {
    size = (await stat(cleaned)).size
  } catch (error) {
    throw new Error(`read attachment ${path}: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (size > maxAttachmentSize) {
    throw new Error(`attachment ${path} exceeds size limit (${maxAttachmentSize >> 20} MB)`)
  }
  let data: Buffer
  try {
    data = await readFile(cleaned)
  } catch (error) {
    throw new Error(`read attachment ${path}: ${String(error instanceof Error ? error.message : error)}`)
  }
  const fileName = basename(cleaned)
  const mimeType = detectAttachmentMimeType(fileName, data)
  if (mimeType.startsWith('image/')) {
    return { mimeType, data: new Uint8Array(data), fileName }
  }
  return { mimeType, data: new Uint8Array(data), fileName }
}

const DESCRIPTION =
  'Deliver generated artifacts (files and images) to the user\'s chat window. '
  + 'This is the ONLY way a file you produced reaches the user — a bare file path in your text reply is NOT delivered '
  + '(the user cannot open your working directory). Pass one or more local file paths; images are sent as image '
  + 'messages, everything else as file messages. Optionally include a short message introducing the delivery; do NOT '
  + 'repeat that same sentence in your normal reply afterwards (both are delivered, and the engine suppresses the '
  + 'duplicate). Use only for artifacts the user should receive, not for ordinary conversation.'

/**
 * Register the `feishu_bridge_send` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerSendTool(ctx: Context, route: SendAgentRouter): () => void {
  return ctx.tools.register(defineTool({
    name: 'feishu_bridge_send',
    description: DESCRIPTION,
    parameters: {
      files: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Local file paths to deliver (absolute, or relative to the session work dir). '
          + 'Images (by content) are sent as image messages, other files as file messages.',
      },
      message: {
        type: 'string',
        description: 'Optional short text sent alongside the attachments. Do not repeat it in your normal reply.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['ok'] },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      if (args.files.length === 0) {
        throw new Error('feishu_bridge_send: at least one file path is required')
      }
      const target = route(exec.agent)
      if (target === undefined) {
        throw new Error('feishu_bridge_send: the calling session is not owned by a feishu-bridge project')
      }
      const { engine, sessionKey } = target
      const workDir = engine.sessionWorkDir(sessionKey)
      const images: ImageAttachment[] = []
      const files: FileAttachment[] = []
      for (const path of args.files) {
        const attachment = await readAttachment(path, workDir)
        if (attachment.mimeType.startsWith('image/')) images.push(attachment)
        else files.push(attachment as FileAttachment)
      }
      await engine.sendToSessionWithAttachments(sessionKey, args.message ?? '', images, files)
      const delivered = [...images.map(i => `${i.fileName ?? 'image'} (image)`), ...files.map(f => `${f.fileName} (file)`)]
      return {
        status: 'ok' as const,
        message: `Message sent successfully. Delivered: ${delivered.join(', ')}.`,
      }
    },
  }))
}
