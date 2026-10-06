import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "보고팡 | 오늘의 쿠팡 할인상품",
  description: "매일 새롭게 확인하는 쿠팡 할인상품과 특가상품",
    icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}