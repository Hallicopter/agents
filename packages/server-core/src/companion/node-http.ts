import type { IncomingMessage, ServerResponse } from 'node:http'

/** Bounded adapter dedicated to companion routes. Does not change WebUI behavior. */
export function companionNodeHandler(getHandler: () => ((req: Request) => Promise<Response>) | null) {
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store')
      // Require TLS at this listener. Never trust attacker-supplied forwarded headers.
      if (!(req.socket as any).encrypted) { res.writeHead(426); res.end('HTTPS required'); return }
      const handler = getHandler()
      if (!handler) { res.writeHead(503); res.end('Companion unavailable'); return }
      let length = 0
      const chunks: Buffer[] = []
      req.setTimeout(10_000, () => req.destroy())
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk)
        length += bytes.length
        if (length > 16_384) { res.writeHead(413); res.end(); return }
        chunks.push(bytes)
      }
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
      const request = new Request(`https://companion.local${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks) })
      const result = await handler(request)
      res.writeHead(result.status, Object.fromEntries(result.headers))
      res.end(await result.text())
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  }
}
