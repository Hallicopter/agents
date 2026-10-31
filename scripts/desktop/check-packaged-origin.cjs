// Isolated Electron file-origin probe. No credentials or live desktop access.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scoville-origin-'))
const server = http.createServer()
let locationOrigin
function finish(code) {
  server.close()
  fs.rmSync(directory, { recursive: true, force: true })
  app.exit(code)
}
server.on('upgrade', (request, socket) => {
  const websocketOrigin = request.headers.origin
  socket.destroy()
  console.log(JSON.stringify({ locationOrigin, websocketOrigin }))
  finish(locationOrigin === 'file://' && websocketOrigin === 'file://' ? 0 : 1)
})
server.listen(0, '127.0.0.1', async () => {
  try {
    await app.whenReady()
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const file = path.join(directory, 'index.html')
    fs.writeFileSync(file, '<!doctype html><title>Origin probe</title>')
    await win.loadFile(file)
    locationOrigin = await win.webContents.executeJavaScript('location.origin')
    await win.webContents.executeJavaScript(`new WebSocket('ws://127.0.0.1:${server.address().port}'); void 0`)
  } catch (error) { console.error(error); finish(1) }
})
setTimeout(() => finish(1), 15000).unref()
