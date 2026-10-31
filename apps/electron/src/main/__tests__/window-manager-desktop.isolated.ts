// Run separately: Electron module mocks must not leak into other native suites.
import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'

let nextId = 1
class NativeWindow extends EventEmitter {
  options: any
  webContents: any
  destroyed = false
  minimized = false
  focused = true
  title = ''
  query: Record<string, string> = {}
  shown = 0
  restored = 0
  constructor(options: any) {
    super()
    this.options = options
    this.webContents = Object.assign(new EventEmitter(), {
      id: nextId++, mainFrame: {},
      setWindowOpenHandler: () => {},
      setIgnoreMenuShortcuts: mock(() => {}),
      isDestroyed: () => this.destroyed,
      getURL: () => `file:///renderer/index.html?${new URLSearchParams(this.query)}`,
      send: () => {},
    })
  }
  async loadFile(_file: string, { query }: { query: Record<string, string> }) { this.query = query }
  async loadURL(url: string) { this.query = Object.fromEntries(new URL(url).searchParams) }
  setTitle(title: string) { this.title = title }
  isDestroyed() { return this.destroyed }
  isMinimized() { return this.minimized }
  isFocused() { return this.focused }
  restore() { this.minimized = false; this.restored++ }
  show() { this.shown++ }
  focus() { this.focused = true }
  getBounds() { return { x: 0, y: 0, width: 1100, height: 760 } }
  destroy() { this.destroyed = true; this.emit('closed') }
}
const log = { info() {}, warn() {}, error() {} }
mock.module('electron', () => ({
  BrowserWindow: NativeWindow, clipboard: {}, shell: {}, Menu: {},
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
  app: { getName: () => 'Craft Agents', isPackaged: false },
}))
mock.module('@craft-agent/shared/config', () => ({ getWorkspaceByNameOrId: (id: string) => ({ name: id }) }))
mock.module('@craft-agent/shared/i18n', () => ({ i18n: { t: (key: string) => key } }))
mock.module('../logger', () => ({ windowLog: log }))
mock.module('../zoom', () => ({ applyDefaultZoom: () => {} }))
mock.module('../context-menu', () => ({ buildContextMenuTemplate: () => [] }))
const { WindowManager } = await import('../window-manager')
const asNative = (window: unknown) => window as NativeWindow

describe('dedicated native Desktop window', () => {
  it('uses the trusted workspace/preload and a normal native frame, no remote desktop instance', () => {
    const manager = new WindowManager()
    const window = asNative(manager.openDesktopWindow('workspace-a', 'session-a'))
    expect(manager.getWorkspaceForWindow(window.webContents.id)).toBe('workspace-a')
    expect(window.options.webPreferences.preload).toEndWith('bootstrap-preload.cjs')
    expect(window.options.webPreferences.contextIsolation).toBe(true)
    expect(window.options.webPreferences.nodeIntegration).toBe(false)
    expect(window.options.titleBarStyle).toBeUndefined() // standard draggable macOS title bar, too
    expect(window.options.minWidth).toBe(560)
    expect(window.query).toEqual({ workspaceId: 'workspace-a', desktopWindow: 'true', desktopSessionId: 'session-a' })
    expect(window.title).toContain('Desktop')
    window.destroy()
  })
  it('focuses/restores the existing target viewer, not a second window/stream', () => {
    const manager = new WindowManager()
    const window = asNative(manager.openDesktopWindow('workspace-a', 'session-a'))
    window.minimized = true
    expect(manager.openDesktopWindow('workspace-a', 'session-a')).toBe(window as any)
    expect(window.restored).toBe(1)
    expect(window.shown).toBe(1)
    expect(manager.getAllWindows()).toHaveLength(1)
    window.destroy()
  })
  it('never persists a Desktop URL and never substitutes it for a main workspace window', () => {
    const manager = new WindowManager()
    const desktop = asNative(manager.openDesktopWindow('workspace-a', 'session-a'))
    expect(manager.getWindowStates()).toEqual([])
    expect(manager.getWindowByWorkspace('workspace-a')).toBeNull()
    const main = asNative(manager.createWindow({ workspaceId: 'workspace-a' }))
    expect(manager.getWindowByWorkspace('workspace-a')).toBe(main as any)
    expect(manager.getWindowStates()).toHaveLength(1)
    expect(manager.getWindowStates()[0]?.url).not.toContain('desktopSessionId')
    desktop.destroy(); main.destroy()
  })
  it('closes natively without layered chat close interception or stopping the main window', () => {
    const manager = new WindowManager()
    const main = asNative(manager.createWindow({ workspaceId: 'workspace-a' }))
    const desktop = asNative(manager.openDesktopWindow('workspace-a', 'session-a'))
    let prevented = false
    desktop.emit('close', { preventDefault() { prevented = true } })
    expect(prevented).toBe(false)
    desktop.destroy()
    expect(manager.getWorkspaceForWindow(desktop.webContents.id)).toBeNull()
    expect(main.destroyed).toBe(false)
    main.destroy()
  })
  it('bypasses app accelerators only in a focused Desktop, resets on native blur', () => {
    const manager = new WindowManager()
    const main = asNative(manager.createWindow({ workspaceId: 'workspace-a' }))
    const desktop = asNative(manager.openDesktopWindow('workspace-a', 'session-a'))
    manager.setDesktopInputActive(main.webContents.id, true)
    expect(main.webContents.setIgnoreMenuShortcuts).not.toHaveBeenCalled()
    manager.setDesktopInputActive(desktop.webContents.id, true)
    expect(desktop.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    desktop.focused = false
    desktop.emit('blur')
    expect(desktop.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    manager.setDesktopInputActive(desktop.webContents.id, true)
    expect(desktop.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    desktop.destroy(); main.destroy()
  })
})
