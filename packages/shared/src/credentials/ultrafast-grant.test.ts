import { expect, test } from 'bun:test';
import { allowsDispatch, grantProof, selectGrant } from './ultrafast-grant';

test('consent checks selection, parent and actual child for each dispatch', async () => {
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  const click = selectGrant('codex', first);
  let selected: typeof click | undefined = click, current = first, slug = 'codex';
  let revision: string | undefined;
  const send = (child: string) => allowsDispatch(() => selected, () => slug, click.nonce, grantProof(click.nonce, child), async () => current, () => revision);
  expect(await send(first)).toBe(true);
  revision = 'new issuance'; expect(await send(first)).toBe(false); // identical bearer, queued or future dispatch
  revision = undefined;
  current = second; expect(await send(first)).toBe(false); expect(await send(second)).toBe(false);
  selected = selectGrant('codex', second); expect(await send(second)).toBe(false); // queued old nonce
  selected = click; current = first; slug = 'replacement'; expect(await send(first)).toBe(false);
  selected = undefined; expect(await send(first)).toBe(false); // restart
});
