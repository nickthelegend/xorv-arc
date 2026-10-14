import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: { default: "Xorv", template: "%s · Xorv" },
  description:
    "Post an AI job, pay per job in USDC over x402 on Arc from a Privy wallet, watch it run on a live provider node, and rate it on ERC-8004.",
  icons: { icon: [{ url: "/brand/xorv-mark.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">
        <Providers>
          <Shell>{process.env.NEXT_PUBLIC_XORV_READ_ONLY === "1" ? <p role="status" className="mb-6 rounded-lg border border-white/20 p-4 text-sm">Live Arc {process.env.NEXT_PUBLIC_XORV_NETWORK === "eip155:5042" ? "mainnet" : "testnet"} explorer · job execution is offline. Start the local broker and a provider to run jobs. You can browse verified video job history, draft a prompt and inspect deployed contracts here; no hosted payment is taken.</p> : null}{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
