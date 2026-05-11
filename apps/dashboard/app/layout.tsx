import type { ReactNode } from "react";

export const metadata = {
  title: "IssuePilot Dashboard",
  description: "Read-only timeline of IssuePilot orchestrator runs.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
