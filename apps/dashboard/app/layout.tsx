import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "IssuePilot Dashboard",
  description: "Read-only timeline of IssuePilot orchestrator runs.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
