import React from "react";
import ReactMarkdown from "react-markdown";
import fs from "fs";
import path from "path";

export default async function Page() {
  const p = path.join(process.cwd(), "public", "daily", "latest.md");
  const md = fs.readFileSync(p, "utf8");
  return <main className="prose mx-auto p-6"><ReactMarkdown>{md}</ReactMarkdown></main>;
}
