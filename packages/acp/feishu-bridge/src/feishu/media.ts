/**
 * Media helpers ported from cc-connect platform/feishu/feishu_media.go: file
 * type mapping for uploads, magic-byte MIME sniffing for downloads, and the
 * download-size ceiling. The send/upload/download flows themselves live on
 * FeishuPlatform (they route through the reply/create machinery there).
 *
 * @module dsh-feishu-bridge/feishu-media
 */

/** Max size for downloaded message resources (Go maxFeishuDownloadBytes). */
/** Feishu im/v1 upload file_type values (Go larkim.CreateFileFileType*). */
export type FeishuFileType = 'pdf' | 'doc' | 'xls' | 'ppt' | 'mp4' | 'opus' | 'stream'

export const maxFeishuDownloadBytes = 100 << 20

/**
 * Map a file attachment to Feishu's im/v1 upload file_type by MIME type and
 * name suffix; anything unrecognized uploads as a plain stream.
 * @param mimeType - Attachment MIME type (may be empty).
 * @param fileName - Attachment file name.
 * @returns Feishu file_type value.
 */
export function detectFeishuFileType(mimeType: string, fileName: string): 'pdf' | 'doc' | 'xls' | 'ppt' | 'mp4' | 'opus' | 'stream' {
  const name = fileName.toLowerCase()
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.doc') || name.endsWith('.docx')) return 'doc'
  if (name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.csv')) return 'xls'
  if (name.endsWith('.ppt') || name.endsWith('.pptx')) return 'ppt'
  if (mimeType === 'video/mp4' || name.endsWith('.mp4')) return 'mp4'
  if (mimeType === 'audio/ogg' || mimeType === 'audio/opus' || name.endsWith('.opus')) return 'opus'
  return 'stream'
}

/**
 * Sniff an image's MIME type from magic bytes. Unknown bytes fall through to
 * image/png, which surfaces a clean decode error downstream for garbage.
 * @param data - Image bytes.
 * @returns MIME type string.
 */
export function detectMimeType(data: Uint8Array): string {
  if (data.length >= 8) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
    if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
    const head = new TextDecoder().decode(data.subarray(0, 4))
    if (head === 'GIF8') return 'image/gif'
    if (head === 'RIFF' && data.length >= 12 && new TextDecoder().decode(data.subarray(8, 12)) === 'WEBP') {
      return 'image/webp'
    }
  }
  return 'image/png'
}
