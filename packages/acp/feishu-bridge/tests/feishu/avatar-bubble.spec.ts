import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { lucideIconSVG } from '../../src/lucide/icon.ts'
import { renderIconPNG } from '../../src/feishu/avatar.ts'

// Ported from cc-connect platform/feishu/feishu_avatar_icon_bubble_test.go: the
// bubble's large arc (second parameter group of a single `a` command) must
// actually draw. The Go regression was an oksvg multi-arc bug; the assertion is
// the rendered white-pixel mass staying far above the broken baseline.

describe('renderIconPNG message-circle-warning bubble', () => {
  it('draws the bubble outline (upper-half white pixels present)', async () => {
    const svg = lucideIconSVG('message-circle-warning', '#ffffff')
    expect(svg).toBeDefined()
    const pngBytes = await renderIconPNG(svg!, 256, { r: 0x2d, g: 0x7a, b: 0x80 })

    const { data, info } = await sharp(Buffer.from(pngBytes)).raw().toBuffer({ resolveWithObject: true })
    let white = 0
    let whiteUpper = 0
    const midY = Math.floor(info.height / 2)
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels
        if (data[i]! > 234 && data[i + 1]! > 234 && data[i + 2]! > 234) {
          white++
          if (y < midY) whiteUpper++
        }
      }
    }
    // The bubble arc is the icon body; the thresholds sit far below the healthy
    // render and far above the arc-missing regression baseline.
    expect(white).toBeGreaterThanOrEqual(5000)
    expect(whiteUpper).toBeGreaterThanOrEqual(2500)
  })
})
