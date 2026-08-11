import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIRA extraction",
  description: "Turn a research paper into a validated MIRA graph — questions, claims, evidence, studies, protocols, sources, requests — for human review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
