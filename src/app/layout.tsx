// app/layout.tsx
import React from "react";

export const metadata = { title: "US Market Diary" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>{children}</body>
    </html>
  );
}
