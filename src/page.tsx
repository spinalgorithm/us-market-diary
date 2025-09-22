import fs from "fs";
import path from "path";
import React from "react";
import ReactMarkdown from "react-markdown";

export const revalidate = 3600;        // 1시간마다 ISR
export const dynamic = "force-static"; // 정적 처리 강제

export default async function Page() {
  const p = path.join(process.cwd(), "public", "daily", "latest.md");
  const md = fs.readFileSync(p, "utf8"); // 없으면 빌드 실패하니 아래 '플레이스홀더' 생성
  return (
    <main style={{maxWidth: 860, margin: "0 auto", padding: 24}}>
      <ReactMarkdown>{md}</ReactMarkdown>
    </main>
  );
}
