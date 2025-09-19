// src/app/api/eod-deep-mde/route.ts
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Vercel 10초~수십초 제한 대비: 적당한 타임아웃(예: 25초)
const TIMEOUT_MS = 25_000;

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const target = `${u.origin}/api/eod-deep${u.search}`; // ← 실제 라우트와 맞추기

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(target, {
      cache: "no-store",
      signal: ctrl.signal,
      // 유용한 UA 넣어두면 서버측 로깅에서 구분 쉬움(선택)
      headers: { "user-agent": "eod-deep-mde-proxy/1.0" },
      // Next 캐시 완전 우회(선택)
      next: { revalidate: 0 },
    });

    // 백엔드 에러를 그대로 전달
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return new Response(
        text || `Upstream error (${resp.status})`,
        { status: resp.status || 502 }
      );
    }

    // eod-deep이 { ok, markdown } JSON으로 주는 설계라면:
    const j = await resp.json().catch(() => null);
    if (j && typeof j === "object" && "ok" in j) {
      if (!j.ok) {
        return new Response(String(j.error || "error"), { status: 500 });
      }
      return new Response(String(j.markdown || ""), {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    // 만약 eod-deep이 원래부터 마크다운 원문을 바로 준다면(스트레이트 패스)
    // 위 json() 파싱에서 실패했을 수 있으니 resp를 text로 재요청
    const md = await (await fetch(target, { cache: "no-store" })).text();
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });

  } catch (err: any) {
    const msg =
      err?.name === "AbortError"
        ? "Upstream timeout"
        : (err?.message || "proxy failure");
    return new Response(msg, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
