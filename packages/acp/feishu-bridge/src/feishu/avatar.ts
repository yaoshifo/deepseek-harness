/**
 * Lucide icon avatar rendering and avatar grayscaling, ported from cc-connect
 * platform/feishu/feishu_avatar_icon.go + feishu_avatar_gray.go (#52).
 *
 * Go rasterized SVGs with oksvg+rasterx and grayscaled with image/png; here
 * sharp (librsvg + libvips) does both, which is why the grayscale output uses
 * gamma-corrected luma instead of Go's integer sRGB weights — the perceptual
 * ordering (green brightest, blue dimmest) is what callers rely on.
 *
 * @module dsh-feishu-bridge/feishu-avatar
 */

import sharp from 'sharp'
import { fnv1a32 } from '../lucide/icon.ts'
import type { ChatPhase } from '../core/types.ts'

/** 8-bit RGBA color. */
export interface RGBA {
  r: number
  g: number
  b: number
  a?: number
}

/**
 * Background color of the /done gray avatar variant (mid-dark grey). A white
 * icon stays high-contrast on it, and the greyed background reads "inactive" —
 * clearer than desaturating the whole avatar.
 */
export const iconGrayBG: RGBA = { r: 0x6b, g: 0x72, b: 0x80 }

/**
 * Fixed avatar background per lifecycle phase (replaces the old name-hashed
 * random hue). Yellow/blue/green share S=0.65 L=0.50 so a white icon keeps
 * high contrast on every phase; red sits darker so red-green colorblind users
 * can still separate `attention` from `approved` by lightness.
 */
export const phaseAvatarBG: Record<ChatPhase, RGBA> = {
  discussing: { r: 0xd9, g: 0x99, b: 0x06 },
  'plan-review': { r: 0x2e, g: 0x7c, b: 0xd9 },
  approved: { r: 0x22, g: 0xa8, b: 0x67 },
  attention: { r: 0xb5, g: 0x25, b: 0x1e },
  done: iconGrayBG,
}

/**
 * Pick a non-phase avatar background by hashing the seed (group name) to a hue
 * with fixed saturation/lightness: same name → same color. Used only by chats
 * outside the lifecycle-phase language (chatroom families, branded hubs), so
 * they stay visually distinct from phase-painted task groups.
 * @param seed - Group name.
 * @returns Opaque background color.
 */
export function groupAvatarColor(seed: string): RGBA {
  return hslToRGB(fnv1a32(seed) % 360, 0.65, 0.50)
}

/**
 * Convert HSL to 8-bit RGBA (standard algorithm; no HSL in the platform's
 * color toolbox).
 * @param h - Hue in [0, 360).
 * @param s - Saturation in [0, 1].
 * @param l - Lightness in [0, 1].
 * @returns Opaque RGBA color.
 */
export function hslToRGB(h: number, s: number, l: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (hp < 1) [r1, g1, b1] = [c, x, 0]
  else if (hp < 2) [r1, g1, b1] = [x, c, 0]
  else if (hp < 3) [r1, g1, b1] = [0, c, x]
  else if (hp < 4) [r1, g1, b1] = [0, x, c]
  else if (hp < 5) [r1, g1, b1] = [x, 0, c]
  else [r1, g1, b1] = [c, 0, x]
  const m = l - c / 2
  const to8 = (v: number): number => Math.round(v * 255 + 0.5) & 0xff
  return { r: to8(r1 + m), g: to8(g1 + m), b: to8(b1 + m), a: 255 }
}

/**
 * Rasterize a standalone SVG string into a size×size PNG: solid `bgColor`
 * background with the icon drawn in the central 60% (20% padding, never
 * touching an edge). The stroke color is the SVG's own (white from
 * `lucideIconSVG`).
 * @param svg - Standalone SVG document.
 * @param size - Output canvas width/height in pixels.
 * @param bgColor - Opaque background fill.
 * @returns PNG bytes.
 */
export async function renderIconPNG(svg: string, size: number, bgColor: RGBA): Promise<Uint8Array> {
  const iconSize = Math.round(size * 0.6)
  const pad = Math.round(size * 0.2)
  // Density scales librsvg's render resolution: the sprite is a 24×24 viewBox,
  // so 72·iconSize/24 DPI lands the icon at exactly iconSize pixels.
  const inner = await sharp(Buffer.from(svg), { density: (72 * iconSize) / 24 })
    .resize(iconSize, iconSize)
    .png()
    .toBuffer()
  const out = await sharp({
    // sharp's background wants {r,g,b,alpha}; the a field is dropped.
    create: { width: size, height: size, channels: 4, background: { r: bgColor.r, g: bgColor.g, b: bgColor.b, alpha: 1 } },
  })
    .composite([{ input: inner, left: pad, top: pad }])
    .png()
    .toBuffer()
  return new Uint8Array(out)
}

/**
 * Perceptually grayscale an avatar (any sharp-decodable format) and return
 * PNG bytes. Uploaded once at startup as the /done avatar variant so a spawned
 * group's inactive state is visible at a glance.
 * @param data - Encoded avatar image bytes.
 * @returns Grayscale PNG bytes.
 */
export async function grayscaleAvatar(data: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(data)).grayscale().png().toBuffer()
  return new Uint8Array(out)
}
