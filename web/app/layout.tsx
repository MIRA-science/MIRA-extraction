import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIRA Graph Extractor",
  description: "Turn a research paper into a proposed MIRA graph — question/claim/evidence/study/source — for human review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
