import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const origin = req.nextUrl.origin;
    const search = req.nextUrl.search; // ex) ?lang=ja&date=2025-09-04&model=gpt-5
    const url = `${origin}/api/eod-deep${search}`;

    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();

    if (!j?.ok) {
      return new NextResponse(`Error: ${j?.error ?? r.statusText}`, {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    return new NextResponse(j.markdown || '', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-model-used': j.modelUsed || '',
        'x-date-et': j.dateEt || '',
      },
    });
  } catch (e: any) {
    return new NextResponse(`Error: ${e?.message ?? String(e)}`, {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
}
