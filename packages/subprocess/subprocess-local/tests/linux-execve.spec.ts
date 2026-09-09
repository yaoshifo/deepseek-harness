import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('koffi')
  vi.resetModules()
})

describe.skipIf(process.platform !== 'linux')('Linux libc execve binding', () => {
  it('preserves inherited stdio, null-terminates argv and envp, and reports execve errno', async () => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === 2) return 0
      return [1, 0, 5][fd]
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('koffi', () => ({ default: { errno, load } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' })
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
      [1, 1, 0],
      [1, 3, 0],
      [2, 1, 0],
      [2, 2, 4],
      [2, 3, 0],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("ENOENT: no such file or directory, execve '/missing/tool'")
  })

  it('restores blocking stdio status flags before replacing the process', async () => {
    // The Node runtime that hosts the bootstrap leaves pipe-backed stdio in
    // non-blocking mode; execve preserves status flags, so the runner must
    // clear O_NONBLOCK or the target's writes to a full pipe fail with EAGAIN.
    const O_NONBLOCK = 0o4000
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === 1) return 0
      if (command === 3) return O_NONBLOCK | 0o1
      return 0
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 2)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    let failure: unknown
    try {
      loadLinuxExecve()('/missing/tool', ['tool'], {})
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 3, 0],
      [0, 4, 0o1],
      [1, 1, 0],
      [1, 3, 0],
      [1, 4, 0o1],
      [2, 1, 0],
      [2, 3, 0],
      [2, 4, 0o1],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith('/missing/tool', ['tool', null], [null])
    expect(failure).toMatchObject({ code: 'ENOENT', syscall: 'execve', path: '/missing/tool' })
  })

  it('reports failure to read stdio status flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === 1) return 0
      return -1
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 3, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear non-blocking stdio before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === 1) return 0
      if (command === 3) return 0o4002
      return -1
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 3, 0],
      [0, 4, 0o2],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to read descriptor flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn(() => -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenCalledExactlyOnceWith(0, 1, 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear close-on-exec before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('koffi', () => ({ default: { errno, load: () => ({ func }) } }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })
})
