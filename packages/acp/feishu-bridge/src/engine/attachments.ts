/**
 * Attachment staging ported from cc-connect core/message.go (#8): pure-attachment
 * messages (Feishu image/file messages carry no text) are persisted to a
 * per-state pending directory and spliced into the next text prompt as path
 * references — the Go dsh backend never places image bytes into the model
 * context directly; the agent reads the staged files with its own tools.
 *
 * @module dsh-feishu-bridge/attachments
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FileAttachment, ImageAttachment } from '../core/types.ts'

/** One staged attachment waiting for the next text message (Go stagedAttachment). */
export interface StagedAttachment {
  messageID: string
  kind: 'image' | 'file'
  path: string
}

/**
 * File extension for an image MIME type (Go ImageExtFromMime).
 *
 * @param mime - MIME type of an image attachment; unknown types map to PNG.
 * @returns The file extension including the leading dot.
 */
export function imageExtFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg'
    case 'image/gif': return '.gif'
    case 'image/webp': return '.webp'
    default: return '.png'
  }
}

/**
 * Resolve fname inside dir, suffixing `(n)` before the extension while the
 * name is taken: a pending dir accumulates uploads from several messages, and
 * an overwrite would silently swap an earlier message's staged bytes.
 *
 * @param dir - Destination directory.
 * @param fname - Requested file name.
 * @returns A path inside dir not currently occupied on disk.
 */
function uniquePathIn(dir: string, fname: string): string {
  let fpath = join(dir, fname)
  if (!existsSync(fpath)) return fpath
  const dot = fname.lastIndexOf('.')
  const stem = dot > 0 ? fname.slice(0, dot) : fname
  const ext = dot > 0 ? fname.slice(dot) : ''
  for (let n = 1; ; n++) {
    fpath = join(dir, `${stem}(${n})${ext}`)
    if (!existsSync(fpath)) return fpath
  }
}

/**
 * Write image attachments into dir and return their paths (Go saveImagesToDir);
 * a name already present in dir gets a `(n)` suffix instead of overwriting.
 *
 * @param dir - Destination directory, created if missing.
 * @param images - Image attachments to write; empty input skips the directory.
 * @returns Paths of the images actually written; failed writes are skipped.
 */
export function saveImagesToDir(dir: string, images: ImageAttachment[]): string[] {
  if (images.length === 0) return []
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn(`saveImagesToDir: mkdir failed (${dir}): ${String(error)}`)
  }
  const paths: string[] = []
  const now = Date.now()
  for (const [i, img] of images.entries()) {
    const fname = img.fileName ?? `img_${now}_${i}${imageExtFromMime(img.mimeType)}`
    const fpath = uniquePathIn(dir, fname)
    try {
      writeFileSync(fpath, img.data)
      paths.push(fpath)
    } catch (error) {
      console.warn(`saveImagesToDir: save image failed: ${String(error)}`)
    }
  }
  return paths
}

/**
 * Write file attachments into dir and return their paths (Go saveFilesToDir);
 * a name already present in dir gets a `(n)` suffix instead of overwriting.
 *
 * @param dir - Destination directory, created if missing.
 * @param files - File attachments to write; empty input skips the directory.
 * @returns Paths of the files actually written; failed writes are skipped.
 */
export function saveFilesToDir(dir: string, files: FileAttachment[]): string[] {
  if (files.length === 0) return []
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn(`saveFilesToDir: mkdir failed (${dir}): ${String(error)}`)
  }
  const paths: string[] = []
  const now = Date.now()
  for (const [i, f] of files.entries()) {
    const fname = f.fileName !== '' ? f.fileName : `file_${now}_${i}`
    const fpath = uniquePathIn(dir, fname)
    try {
      writeFileSync(fpath, f.data)
      paths.push(fpath)
    } catch (error) {
      console.error(`saveFilesToDir: write failed: ${String(error)}`)
    }
  }
  return paths
}

/**
 * Save images to workDir/.feishu-bridge/attachments (Go SaveImagesToDisk).
 *
 * @param workDir - Session workspace root.
 * @param images - Image attachments to write.
 * @returns Paths of the images actually written.
 */
export function saveImagesToDisk(workDir: string, images: ImageAttachment[]): string[] {
  return saveImagesToDir(join(workDir, '.feishu-bridge', 'attachments'), images)
}

/**
 * Save files to workDir/.feishu-bridge/attachments (adapter send path).
 *
 * @param workDir - Session workspace root.
 * @param files - File attachments to write.
 * @returns Paths of the files actually written.
 */
export function saveFilesToDisk(workDir: string, files: FileAttachment[]): string[] {
  return saveFilesToDir(join(workDir, '.feishu-bridge', 'attachments'), files)
}

/**
 * Append file path references to a prompt (Go AppendFileRefs).
 *
 * @param prompt - Existing prompt text; may be empty.
 * @param filePaths - Local paths of saved files the agent should read.
 * @returns The prompt with the reference line appended, or the prompt unchanged when there are no paths.
 */
export function appendFileRefs(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) return prompt
  const ref = `(Files saved locally, please read them: ${filePaths.join(', ')})`
  if (prompt === '') return ref
  return `${prompt}\n\n${ref}`
}

/**
 * Append image paths as a markdown bullet list with no prose (Go AppendImageRefs).
 *
 * @param prompt - Existing prompt text; may be empty.
 * @param imagePaths - Local paths of saved images the agent should read.
 * @returns The prompt with the bullet list appended, or the prompt unchanged when there are no paths.
 */
export function appendImageRefs(prompt: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return prompt
  const ref = imagePaths.map(p => `- ${p}`).join('\n')
  if (prompt === '') return ref
  return `${prompt}\n\n${ref}`
}

/**
 * Splice staged image/file paths into a prompt as a markdown bullet list
 * (Go spliceStagedAttachments): images first, then files, all as plain
 * `- <path>` bullets.
 *
 * @param prompt - Existing prompt text; may be empty.
 * @param imagePaths - Local paths of staged images, listed first.
 * @param filePaths - Local paths of staged files, listed after the images.
 * @returns The prompt with all staged paths appended as bullets, or the prompt unchanged when nothing is staged.
 */
export function spliceStagedAttachments(prompt: string, imagePaths: string[], filePaths: string[]): string {
  return appendImageRefs(prompt, [...imagePaths, ...filePaths])
}

/**
 * The per-state staging directory for attachments waiting for the user's
 * next text message (Go pendingDirFor): namespaced by a short hash of the
 * interactive key so concurrent chats under the same workDir never collide,
 * and outside .feishu-bridge/attachments (which the agent clears per Send).
 *
 * @param workspaceDir - Session workspace root.
 * @param interactiveKey - Key of the interactive session waiting for attachments.
 * @returns The pending directory path for that session.
 */
export function pendingDirFor(workspaceDir: string, interactiveKey: string): string {
  const sum = createHash('sha256').update(interactiveKey).digest('hex').slice(0, 12)
  return join(workspaceDir, '.feishu-bridge', 'pending', sum)
}
