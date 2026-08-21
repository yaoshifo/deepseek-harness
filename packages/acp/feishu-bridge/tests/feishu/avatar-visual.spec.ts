import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { lucideIconSVG } from '../../src/lucide/icon.js'
import { groupAvatarColor, iconGrayBG, renderIconPNG } from '../../src/feishu/avatar.js'

// Ported from cc-connect platform/feishu/feishu_avatar_icon_visual_test.go.

describe('groupAvatarColor', () => {
  it('is deterministic per seed and opaque', () => {
    const c1 = groupAvatarColor('登录500修复')
    expect(groupAvatarColor('登录500修复')).toEqual(c1)
    expect(c1.a).toBe(255)
  })

  it('varies across seeds', () => {
    const c1 = groupAvatarColor('登录500修复')
    const others = ['db 迁移', '前端重构', '部署流水线', '接口联调', '权限系统']
    expect(others.some(s => groupAvatarColor(s) !== c1)).toBe(true)
  })
})

describe('renderIconPNG', () => {
  it('fills the background and keeps the icon off the corners', async () => {
    const svg = lucideIconSVG('bug', '#ffffff')
    expect(svg).toBeDefined()
    const bg = { r: 0x33, g: 0x70, b: 0xff }
    const pngBytes = await renderIconPNG(svg!, 64, bg)

    const { data, info } = await sharp(Buffer.from(pngBytes)).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }
    }
    // Four corners are the background color (20% padding, icon never touches
    // an edge).
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]] as const) {
      expect(at(x, y)).toEqual(bg)
    }
    // The center carries an icon stroke (white), not the background.
    expect(at(Math.floor(info.width / 2), Math.floor(info.height / 2))).not.toEqual(bg)
  })

  it('renders color and gray backgrounds to different bytes', async () => {
    const svg = lucideIconSVG('bug', '#ffffff')!
    const colorPNG = await renderIconPNG(svg, 64, groupAvatarColor('x'))
    const grayPNG = await renderIconPNG(svg, 64, iconGrayBG)
    expect(Buffer.compare(Buffer.from(colorPNG), Buffer.from(grayPNG))).not.toBe(0)
  })

  it('renders the tag icon whose sprite uses currentColor fills', async () => {
    // Regression #52: <circle fill="currentColor"> must not abort rendering.
    const svg = lucideIconSVG('tag', '#ffffff')
    expect(svg).toBeDefined()
    await expect(renderIconPNG(svg!, 256, { r: 0x33, g: 0x70, b: 0xff })).resolves.toBeDefined()
  })

  it('renders book-open as pages, not just the spine', async () => {
    const svg = lucideIconSVG('book-open', '#ffffff')
    expect(svg).toBeDefined()
    const size = 256
    const bg = { r: 0x33, g: 0x70, b: 0xff }
    const pngBytes = await renderIconPNG(svg!, size, bg)

    const { data, info } = await sharp(Buffer.from(pngBytes)).raw().toBuffer({ resolveWithObject: true })
    let minX = size
    let maxX = 0
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels
        const isBg = data[i] === bg.r && data[i + 1]! === bg.g && data[i + 2]! === bg.b
        if (!isBg) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
    }
    // Page outlines span most of the canvas; a spine-only bar spans ~a stroke
    // width.
    expect(maxX - minX).toBeGreaterThanOrEqual(size / 3)
  })
})
