// Test fixture only: bundled by browser-fixture.ts, never imported by the application.
// @ts-expect-error noVNC ships no declarations
import RfbModule from '@novnc/novnc/lib/rfb.js'
const RFB = typeof RfbModule === 'function' ? RfbModule : RfbModule.default
const response = await fetch('/fixture-grant')
const { token, url } = await response.json() as { token: string; url: string }
const socket = new WebSocket(url)
socket.onopen = () => socket.send(JSON.stringify({ token }))
socket.onmessage = event => {
  if (JSON.parse(event.data).ready !== true) throw new Error('Fixture not ready')
  const viewer = new RFB(document.getElementById('screen'), socket, { shared: true })
  viewer.viewOnly = true
  viewer.scaleViewport = true
  viewer.resizeSession = false
  viewer.addEventListener('connect', () => {
    document.getElementById('status')!.textContent = 'CONNECTED — actual noVNC client / isolated fixture'
    // Verify a rendered raw framebuffer, not merely handshake success.
    const timer = setInterval(() => {
      const canvas = document.querySelector('canvas')
      const pixel = canvas?.getContext('2d')?.getImageData(20, 20, 1, 1).data
      if (pixel && pixel[0] === 40 && pixel[1] === 160 && pixel[2] === 220) {
        document.body.dataset.result = 'framebuffer-rendered'
        document.getElementById('status')!.textContent = 'PASS — framebuffer rendered · watch-only · no live desktop'
        clearInterval(timer)
        void fetch('/fixture-rendered', { method: 'POST' })
      }
    }, 100)
  })
  viewer.addEventListener('disconnect', () => { document.getElementById('status')!.textContent = 'DISCONNECTED' })
}
