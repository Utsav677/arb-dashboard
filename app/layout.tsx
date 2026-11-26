import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arb Paper Trader — Dashboard",
  description:
    "Read-only dashboard for the Kalshi vs Polymarket cross-venue arbitrage paper trader (fake money).",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
