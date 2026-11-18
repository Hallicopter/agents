import { createHmac, randomUUID } from 'node:crypto';

// Volatile by design. Replacing even the access token on refresh needs a new click.
export function grantProof(nonce: string, bearer: string): string {
  return createHmac('sha256', bearer).update(nonce).digest('base64url');
}

export function selectGrant(slug: string, bearer: string, revision?: string, connectionCreatedAt?: number) {
  if (!slug || !bearer) throw new Error('Sign in and reselect Ultrafast');
  const nonce = randomUUID();
  return { nonce, slug, revision, connectionCreatedAt, proof: grantProof(nonce, bearer) };
}

export type SelectedGrant = ReturnType<typeof selectGrant>;
export async function allowsDispatch(selected: () => SelectedGrant | undefined, currentSlug: () => string | undefined,
  nonce: string, proof: string, readBearer: (slug: string) => Promise<string | undefined>,
  readRevision: (slug: string) => string | undefined): Promise<boolean> {
  const grant = selected();
  if (!grant || grant.nonce !== nonce || grant.slug !== currentSlug() || proof !== grant.proof) return false;
  const actual = await readBearer(grant.slug);
  return !!actual && selected() === grant && currentSlug() === grant.slug && grantProof(nonce, actual) === proof
    && readRevision(grant.slug) === grant.revision; // one request in flight from this decision
}
