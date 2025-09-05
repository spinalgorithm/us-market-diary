import { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const r = await fetch(req.nextUrl.origin + '/api/eod-deep', { cache: 'no-store' });
  const j = await r.json();
  if (!j.ok) return new Response(j.error ?? 'error', { status: 500 });
  return new Response(j.markdown, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
