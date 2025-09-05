import { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const origin = u.origin;
  const qs = u.search; // lang/date/model/...
  const r = await fetch(`${origin}/api/eod-deep${qs}`, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ ok: false } as any));
  if (!j?.ok) {
    return new Response(j?.error ?? 'error', { status: 500 });
  }
  return new Response(j.markdown, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
