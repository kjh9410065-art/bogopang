import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bogopang.tcflick.com"),
  title: "보고팡 | 쿠팡 인기상품·할인상품·오늘의 특가",
  description: "쿠팡 인기상품과 할인상품, 오늘의 특가, 인기검색, 로켓배송 상품을 한눈에 찾아보는 보고팡.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  keywords: ["보고팡", "쿠팡 인기상품", "쿠팡 할인상품", "쿠팡 특가", "오늘의 특가", "쿠팡 인기검색", "로켓배송"],
  icons: { icon: "/favicon.png" },
  openGraph: {
    type: "website", locale: "ko_KR", siteName: "보고팡",
    title: "보고팡 | 쿠팡 인기상품·할인상품·오늘의 특가",
    description: "쿠팡 인기상품과 할인상품, 오늘의 특가, 인기검색, 로켓배송 상품을 한눈에 찾아보는 보고팡.",
    url: "https://bogopang.tcflick.com/",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "보고팡 쿠팡 상품 발견 서비스" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "보고팡 | 쿠팡 인기상품·할인상품·오늘의 특가",
    description: "쿠팡 인기상품과 할인상품을 한눈에 찾아보는 보고팡.",
    images: ["/og-image.png"],
  },
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