/**
 * M7 HTML→PNG rasterization and delivery tests, ported from cc-connect
 * core/engine_render_image_test.go: the render-png script shell-out branches
 * (unconfigured / missing / failing / flaky-retried) and deliverRenderedImage
 * fallbacks (image message → fit_horizontal card → .html file).
 *
 * @module dsh-feishu-bridge/tests-engine-plan-render-image
 */

import { describe, expect, it } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { Engine } from '../../src/engine/engine.js'
import { deliverRenderedImage, renderHTMLToPNG } from '../../src/engine/plan-render.js'
import { createStubAgent, createStubMediaPlatform, createStubPlatform } from '../stubs/engine-stubs.js'
import { createCardMediaPlatform, tempDir, writeRenderTestScript } from './plan-render-helpers.js'

function pngEngine(script: string): Engine {
  const e = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
  e.planRenderPngScript = script
  return e
}

describe('RenderHTMLToPNG', () => {
  const tmp = tempDir('render-png-test-')
  const htmlPath = join(tmp, 'plan.html')
  writeFileSync(htmlPath, '<html><body>x</body></html>', 'utf8')

  it('not configured', async () => {
    const e = pngEngine('')
    await expect(renderHTMLToPNG(e, htmlPath)).rejects.toThrow(/not configured/)
  })

  it('script not found', async () => {
    const e = pngEngine(join(tmp, 'nope.sh'))
    await expect(renderHTMLToPNG(e, htmlPath)).rejects.toThrow(/not found/)
  })

  it('success', async () => {
    const script = writeRenderTestScript(tmp, 'ok.sh', '#!/bin/sh\necho fake-png > "$2"\n')
    const e = pngEngine(script)
    const pngPath = await renderHTMLToPNG(e, htmlPath)
    expect(pngPath.endsWith('.png')).toBe(true)
    expect(existsSync(pngPath)).toBe(true)
  })

  it('script fails', async () => {
    const script = writeRenderTestScript(tmp, 'fail.sh', '#!/bin/sh\nexit 1\n')
    const e = pngEngine(script)
    await expect(renderHTMLToPNG(e, htmlPath)).rejects.toThrow()
  })

  it('script writes then fails cleans the partial png', async () => {
    const script = writeRenderTestScript(tmp, 'writefail.sh', '#!/bin/sh\necho partial > "$2"\nexit 1\n')
    const e = pngEngine(script)
    const pngPath = htmlPath.replace(/\.html$/, '.png')
    await expect(renderHTMLToPNG(e, htmlPath)).rejects.toThrow()
    expect(existsSync(pngPath)).toBe(false)
  })

  it('transient failure retried then succeeds', async () => {
    // The script fails on the first invocation and succeeds from the second
    // on (chromium OOM-crash mirror); an independent dir avoids cross-talk.
    const flakyDir = tempDir('render-png-flaky-')
    const counter = join(flakyDir, 'n')
    const script = writeRenderTestScript(flakyDir, 'flaky.sh',
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "${counter}"\nif [ "$n" -lt 2 ]; then exit 1; fi\necho fake-png > "$2"\n`)
    const e = pngEngine(script)
    const pngPath = await renderHTMLToPNG(e, htmlPath)
    expect(existsSync(pngPath)).toBe(true)
  })
})

describe('DeliverRenderedImage', () => {
  const tmp = tempDir('render-deliver-test-')
  const htmlPath = join(tmp, 'reply.html')
  writeFileSync(htmlPath, '<html><head><title>修复登录 bug</title></head><body>x</body></html>', 'utf8')
  const script = writeRenderTestScript(tmp, 'ok.sh', '#!/bin/sh\necho fake-png > "$2"\n')

  it('success sends an image message', async () => {
    const p = createStubMediaPlatform()
    const e = pngEngine(script)
    await deliverRenderedImage(e, p, 'ctx', htmlPath)
    expect(p.images).toHaveLength(1)
    expect(p.images[0]?.mimeType).toBe('image/png')
    expect(p.files).toHaveLength(0)
  })

  it('render failure falls back to the html file', async () => {
    const p = createStubMediaPlatform()
    const e = pngEngine('') // unconfigured → renderHTMLToPNG fails → fallback
    await deliverRenderedImage(e, p, 'ctx', htmlPath)
    expect(p.files).toHaveLength(1)
    expect(p.files[0]?.mimeType).toBe('text/html')
    expect(p.images).toHaveLength(0)
  })

  it('a platform without ImageSender falls back to the html file', async () => {
    const p = createStubPlatform() // FileSender? no — plain stub records sends only
    const e = pngEngine(script)
    // The plain stub has no sendFile, so even the html fallback throws; the
    // meaningful assertion is that it did not silently succeed. Go's variant
    // uses stubFileSenderPlatform; mirror that here.
    const fileP = createStubMediaPlatform()
    delete (fileP as Partial<typeof fileP>).sendImage
    await deliverRenderedImage(e, fileP, 'ctx', htmlPath)
    expect(fileP.files).toHaveLength(1)
    expect(fileP.files[0]?.mimeType).toBe('text/html')
    void p
  })

  it('card path preferred over the image message', async () => {
    const p = createCardMediaPlatform()
    const e = pngEngine(script)
    await deliverRenderedImage(e, p, 'ctx', htmlPath)
    expect(p.cards).toHaveLength(1)
    expect(p.images).toHaveLength(0)
    expect(p.uploaded).toBe(1)
    // Go deliverRenderedImage: ImageFill only — no card header/title, the
    // delivered card is just the full-width image.
    const card = p.cards[0] as { header?: unknown; elements: Array<{ kind: string; scaleType?: string }> }
    expect(card.header).toBeUndefined()
    expect(card.elements).toHaveLength(1)
    expect(card.elements[0]?.kind).toBe('image')
    expect(card.elements[0]?.scaleType).toBe('fit_horizontal')
  })

  it('card send failure falls back to the image message', async () => {
    const p = createCardMediaPlatform(new Error('sentinel card error'))
    const e = pngEngine(script)
    await deliverRenderedImage(e, p, 'ctx', htmlPath)
    expect(p.cards).toHaveLength(1)
    expect(p.images).toHaveLength(1)
  })

  it('cancelled signal skips all sends', async () => {
    const p = createStubMediaPlatform()
    const e = pngEngine(script)
    const ctl = new AbortController()
    ctl.abort()
    await expect(deliverRenderedImage(e, p, 'ctx', htmlPath, ctl.signal)).rejects.toThrow()
    expect(p.images).toHaveLength(0)
    expect(p.files).toHaveLength(0)
  })
})
