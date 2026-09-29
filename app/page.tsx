"use client";

import { useMemo, useState } from "react";

type Product = {
  title: string;
  discount: string;
  price: string;
  oldPrice: string;
  category: string;
};

const categories = ["전체", "식품", "생활", "디지털", "주방", "패션", "반려동물"];

const demoProducts: Product[] = [
  { title: "쿠팡 할인상품이 표시되는 영역입니다", discount: "30%", price: "29,900원", oldPrice: "42,900원", category: "생활" },
  { title: "실제 쿠팡 상품 데이터가 연결되면 자동으로 교체됩니다", discount: "25%", price: "19,900원", oldPrice: "26,500원", category: "식품" },
  { title: "오늘의 특가 상품", discount: "40%", price: "39,800원", oldPrice: "66,000원", category: "디지털" },
  { title: "매일 갱신되는 인기 할인상품", discount: "18%", price: "16,400원", oldPrice: "19,900원", category: "주방" },
  { title: "카테고리별 할인상품", discount: "32%", price: "24,900원", oldPrice: "36,500원", category: "패션" },
  { title: "새롭게 갱신된 특가상품", discount: "27%", price: "21,900원", oldPrice: "29,900원", category: "반려동물" },
  { title: "보고팡에서 한눈에 보는 할인상품", discount: "35%", price: "12,900원", oldPrice: "19,900원", category: "생활" },
  { title: "쿠팡 Gold Box 연동 영역", discount: "22%", price: "34,900원", oldPrice: "44,900원", category: "식품" },
];

export default function Home() {
  const [category, setCategory] = useState("전체");
  const [query, setQuery] = useState("");

  const products = useMemo(() => {
    return demoProducts.filter((product) => {
      const matchesCategory = category === "전체" || product.category === category;
      const matchesQuery = product.title.toLowerCase().includes(query.toLowerCase());
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <a className="logo" href="/">보고<span>팡</span></a>
          <div className="search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="상품을 검색해보세요"
              aria-label="상품 검색"
            />
          </div>
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <h1>오늘 뭐 할인하지?</h1>
          <p>매일 새롭게 확인하는 쿠팡 할인상품과 특가상품</p>
        </section>

        <nav className="categories" aria-label="상품 카테고리">
          {categories.map((item) => (
            <button
              className={`category ${category === item ? "active" : ""}`}
              key={item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </nav>

        <section>
          <div className="section-head">
            <h2>{category === "전체" ? "오늘의 할인상품" : category}</h2>
            <span>매일 오전 자동 갱신</span>
          </div>

          <div className="grid">
            {products.map((product, index) => (
              <article className="card" key={index}>
                <div className="thumb">상품 이미지</div>
                <div className="card-body">
                  <div className="badge">{product.discount} 할인</div>
                  <div className="title">{product.title}</div>
                  <div className="price-row">
                    <span className="discount">{product.discount}</span>
                    <span className="price">{product.price}</span>
                  </div>
                  <div className="old-price">{product.oldPrice}</div>
                  <a className="buy" href="#" onClick={(event) => event.preventDefault()}>
                    쿠팡에서 보기
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer className="notice">
          <strong>쿠팡 파트너스 안내</strong><br />
          이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.
        </footer>
      </main>
    </>
  );
}