// Preload before the interceptor. No path through this fixture reaches a network.
import { zstdDecompressSync } from 'node:zlib';

globalThis.fetch = (async (url, init) => {
  const body = JSON.parse(new Headers(init?.headers).get('content-encoding') === 'zstd' && init?.body instanceof Uint8Array
    ? zstdDecompressSync(init.body).toString('utf8') : String(init?.body));
  console.error('TOOLS ' + JSON.stringify(body.tools));
  console.error('POST ' + JSON.stringify([url, init?.method, body.model, body.service_tier, new Headers(init?.headers).get('x-codex-routing-hint')]));
  if (process.env.FIXTURE === 'network') throw new Error('mock network failure');
  if (!['default', 'standard'].includes(process.env.FIXTURE!)) return Response.json({ error: { message: 'mock failure' } }, { status: Number(process.env.FIXTURE) });
  const response = { id: 'resp_fixture', status: 'completed', service_tier: 'default', output: [{ type: 'message', role: 'assistant', id: 'msg_fixture', content: [{ type: 'output_text', text: 'fixture success' }] }] };
  const events = [{ type: 'response.output_item.added', output_index: 0, item: response.output[0] }, { type: 'response.output_text.delta', output_index: 0, delta: 'fixture success' }, { type: 'response.output_item.done', output_index: 0, item: response.output[0] }, { type: 'response.completed', response }];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;
