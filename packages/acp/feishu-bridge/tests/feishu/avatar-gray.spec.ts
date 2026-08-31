import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { grayscaleAvatar } from '../../src/feishu/avatar.ts'
import { detectMimeType } from '../../src/feishu/media.ts'

// Ported from cc-connect platform/feishu/feishu_avatar_gray_test.go. Go asserted
// integer sRGB luma values (76/150/29); sharp applies gamma-corrected luma
// (127/220/76 for pure R/G/B), which keeps the perceptual ordering — green
// brightest, blue dimmest — that the Go test pinned.

describe('grayscaleAvatar', () => {
  it('maps pure channels to perceptual luminance and stays 3×1 PNG', async () => {
    const src = await sharp({
      create: { width: 3, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).composite([
      {
        input: await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer(),
        left: 1,
        top: 0,
      },
      {
        input: await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(),
        left: 2,
        top: 0,
      },
    ]).png().toBuffer()

    const out = await grayscaleAvatar(new Uint8Array(src))

    expect(detectMimeType(out)).toBe('image/png')
    const { data, info } = await sharp(Buffer.from(out)).raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(3)
    expect(info.height).toBe(1)
    const lum = (x: number) => data[x * info.channels]!
    expect(lum(1)).toBeGreaterThan(lum(0)) // green > red
    expect(lum(0)).toBeGreaterThan(lum(2)) // red > blue
    // Every pixel is gray (R == G == B).
    for (let x = 0; x < 3; x++) {
      const i = x * info.channels
      expect(data[i]).toBe(data[i + 1])
      expect(data[i + 1]).toBe(data[i + 2])
    }
  })

  it('rejects garbage input', async () => {
    await expect(grayscaleAvatar(new Uint8Array(new TextEncoder().encode('not an image')))).rejects.toThrow()
  })
})
