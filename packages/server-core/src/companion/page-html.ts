/** Standalone server runs Bun. HTMLRewriter parses HTML rather than regex-sanitizing it.
 * Clients MUST still disable JS, navigation, network, files/content and all bridges.
 * This strips active elements/attributes; CSP and the native sandbox constrain CSS.
 */
export async function staticPageHtml(html: string): Promise<string | undefined> {
  // Do not truncate midway through markup; use contentText fallback for oversized Pages.
  if (html.length > 200_000) return undefined
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const cleaned = await new HTMLRewriter()
    .on('script,iframe,frame,frameset,object,embed,form,input,button,textarea,select,meta,base,link,audio,video,source,track,foreignObject,animate,animateMotion,animateTransform,set,use', { element(e) { e.remove() } })
    .on('html,head,body', { element(e) { e.removeAndKeepContent() } })
    .on('*', { element(e) {
      for (const [key, value] of [...e.attributes]) {
        const name = key.toLowerCase()
        if (name.startsWith('on') || ['href', 'xlink:href', 'action', 'formaction', 'srcdoc', 'srcset', 'poster', 'background', 'ping'].includes(name)) e.removeAttribute(key)
        if (name === 'src' && !(e.tagName === 'img' && /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value))) e.removeAttribute(key)
      }
    } })
    .transform(new Response(html)).text()
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${cleaned}</body></html>`
}
