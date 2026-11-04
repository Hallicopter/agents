import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseIncomingAgentEnvelope } from '../incoming-agent-envelope'
import { IncomingAgentMessage } from '../IncomingAgentMessage'

const raw = '[Message from session "261030-lean-birch" (Ops (London))]\nUse send_agent_message with sessionId "261030-lean-birch" to reply.\n\n---\n\nReady for review.\n\nFull details and [artifact](https://example.com).'

describe('incoming agent legacy display fallback', () => {
  it('recognizes a historical serialized message without changing its raw content', () => {
    const message = Object.freeze(JSON.parse(JSON.stringify({ role: 'user', content: raw, attachments: [{ id: 'report' }] })))
    expect(parseIncomingAgentEnvelope(message.content)).toEqual({ senderId: '261030-lean-birch', senderName: 'Ops (London)', preview: 'Ready for review.' })
    expect(message.content).toBe(raw)
    expect(message.attachments).toEqual([{ id: 'report' }])
  })
  it('recognizes the same envelope on queued/live delivery and reload', () => {
    for (const flags of [{ isQueued: true }, { isQueued: false }, {}]) {
      expect(parseIncomingAgentEnvelope({ content: raw, ...flags }.content)?.senderId).toBe('261030-lean-birch')
    }
  })
  for (const [name, text] of Object.entries({
    mention: 'Please ask send_agent_message about this.',
    quoted: raw.split('\n').map(line => `> ${line}`).join('\n'),
    code: `\`\`\`text\n${raw}\n\`\`\``,
    embedded: `Review this example:\n${raw}`,
    indented: ` ${raw}`,
    mismatchedSender: raw.replace('sessionId "261030-lean-birch"', 'sessionId "other"'),
    missingReply: raw.replace('Use send_agent_message with sessionId "261030-lean-birch" to reply.\n', ''),
    missingDelimiter: raw.replace('---', '--'),
    extraDelimiterSpace: raw.replace('---', '--- '),
    missingBlankLine: raw.replace('\n\n---', '\n---'),
    missingBody: raw.slice(0, raw.indexOf('Ready')),
    blankBody: raw.slice(0, raw.indexOf('Ready')) + ' \n',
    truncated: raw.slice(0, 110),
    multilineName: raw.replace('Ops (London)', 'Ops\nLondon'),
    invalidId: raw.replaceAll('261030-lean-birch', 'bad"id'),
  })) {
    it(`does not collapse ${name}`, () => expect(parseIncomingAgentEnvelope(text)).toBeNull())
  }
  it('bounds and escapes the preview, leaving the body untouched', () => {
    const content = raw.replace('Ready for review.', '<script>' + 'x'.repeat(200))
    const envelope = parseIncomingAgentEnvelope(content)!
    expect(envelope.preview.length).toBe(120)
    const html = renderToStaticMarkup(<IncomingAgentMessage envelope={envelope} label="Agent message"><p>{content}</p></IncomingAgentMessage>)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(content).toContain('x'.repeat(200))
  })
  it('starts collapsed, with a native keyboard-operable summary and full expansion content', () => {
    const html = renderToStaticMarkup(<IncomingAgentMessage envelope={parseIncomingAgentEnvelope(raw)!} label="Agent message from Ops"><p>{raw}</p><a href="/report">Report</a></IncomingAgentMessage>)
    expect(html).toContain('<details')
    expect(html).not.toMatch(/<details[^>]*\bopen[\s=>]/)
    expect(html).toContain('<summary')
    expect(html).toContain('Full details')
    expect(html).toContain('href="/report"')
    expect(html).toContain('group-open/envelope:hidden')
  })
  it('opts in only at transcript sites and preserves copy, badge offsets and attachments', () => {
    const bubble = readFileSync(new URL('../UserMessageBubble.tsx', import.meta.url), 'utf8')
    expect(bubble).toContain('collapseIncomingAgentMessages = false')
    expect(bubble).toContain('collapseIncomingAgentMessages ? parseIncomingAgentEnvelope(content) : null')
    expect(bubble).toContain('copy(envelope ? content : displayContent)')
    expect(bubble).toContain('renderContentWithBadges(content, inlineBadges, onUrlClick, onFileClick)')
    expect(bubble.indexOf('attachments!.map')).toBeLessThan(bubble.indexOf('<IncomingAgentMessage'))
    for (const file of ['../SessionViewer.tsx', '../../../../../../apps/electron/src/renderer/components/app-shell/chat-display/MessageBubble.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain('collapseIncomingAgentMessages')
    }
  })
})
