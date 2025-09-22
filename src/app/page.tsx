// app/page.tsx
import fs from "fs";
import path from "path";
import React from "react";
import ReactMarkdown from "react-markdown";

export const revalidate = 3600;
export const dynamic = "force-static";

export default function Page() {
  const p = path.join(process.cwd(), "public", "daily", "latest.md");
  let md = "# 준비중\n데이터 생성 전입니다.";
  try { md = fs.readFileSync(p, "utf8"); } catch {}
  return <main><ReactMarkdown>{md}</ReactMarkdown></main>;
}
