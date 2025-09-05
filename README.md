# 미국 야간경비원 — Vercel Cron Starter

## 빠른 시작
1) 이 폴더를 GitHub에 새 레포로 올립니다(예: `us-market-diary`).
2) Vercel에서 **Import Project** → 이 레포 선택.
3) 환경변수 추가:
   - `POLYGON_API_KEY`: (Polygon 메인 키)
   - `OPENAI_API_KEY`: (선택)
   - `SITE_TITLE_PREFIX`: `미국 야간경비원 일지`
4) 배포 후, 스케줄은 `vercel.json`에 따라 **매일 UTC 22:10** 실행됩니다.
5) 테스트: 배포된 도메인에서 `/api/eod` 호출 → JSON 응답의 `markdown` 본문을 note.com에 붙여넣어 게시.

## 파일 설명
- `vercel.json`: 크론 스케줄(하루 1회, UTC 22:10)
- `package.json`: Next.js 14 + TypeScript 의존성
- `src/app/api/eod/route.ts`: 데이터 수집→분석(LLM)→Markdown 생성 API

## 주의
- 무료 플랜 기준, 장중 실시간이 아닌 **EOD** 데이터에 맞춰 동작합니다.
- OpenAI 키가 없으면 간단 요약만 출력되며, 키가 있으면 캐릭터 톤의 장문 기사를 생성합니다.


25-09-05
