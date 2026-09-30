// 보고팡 Cloudflare Worker입니다.
// Git 연동 자동 배포 연결 확인용 최신 버전입니다.
// 쿠팡 파트너스 API를 서버에서 호출해 API 키를 브라우저에 노출하지 않습니다.

const COUPANG_DOMAIN = "https://api-gateway.coupang.com";
const GOLD_BOX_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/goldbox?limit=100&imageSize=300x300";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
const SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/search";
const TREND_RSS_URL = "https://trends.google.com/trending/rss?geo=KR";
const CACHE_URL = "https://bogopang.tcflick.com/api/products";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 수동 갱신 요청은 쿠팡에서 최신 상품을 다시 받아 캐시를 교체합니다.
    if (url.pathname === "/api/refresh" && request.method === "GET") {
      try {
        await refreshProducts(env);
        return new Response(JSON.stringify({ ok: true, message: "상품 갱신 완료" }), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      }
    }

    // 상품 API 요청은 목적별 상품 데이터를 가져와 1시간 캐시합니다.
    if (url.pathname === "/api/products") {
      return getProductsResponse(env, ctx);
    }

    // 나머지 요청은 public 폴더의 정적 사이트를 반환합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    // 매일 한국시간 오전 7시에 상품 데이터를 미리 갱신합니다.
    ctx.waitUntil(refreshProducts(env));
  }
};

// 쿠팡 API 인증에 필요한 HMAC-SHA256 서명을 생성합니다.
async function makeAuthorization(method, pathWithQuery, accessKey, secretKey) {
  // 쿠팡 공식 HMAC 예제와 동일하게 URI를 path와 query로 분리합니다.
  const [path, query = ""] = pathWithQuery.split("?");
  const signedDate = formatUtcDate(new Date());
  const message = signedDate + method + path + query;

  // Secret Key를 HMAC-SHA256 키로 가져옵니다.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 요청 메시지를 서명합니다.
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  // 서명 결과를 16진수 문자열로 변환합니다.
  const signature = [...new Uint8Array(signatureBuffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  // 쿠팡 공식 Authorization 형식과 동일하게 항목 사이에 공백을 넣습니다.
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

// 쿠팡이 요구하는 GMT 기준 yyMMddTHHmmssZ 형식으로 시간을 만듭니다.
function formatUtcDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    String(date.getUTCFullYear()).slice(-2) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

// 쿠팡 파트너스 API를 호출합니다.
async function coupangRequest(method, path, env, body) {
  const authorization = await makeAuthorization(
    method,
    path,
    String(env.COUPANG_ACCESS_KEY || "").trim(),
    String(env.COUPANG_SECRET_KEY || "").trim()
  );

  // API 요청을 전송합니다.
  const response = await fetch(COUPANG_DOMAIN + path, {
    method,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json;charset=UTF-8",
      "X-EXTENDED-TIMEOUT": "90000"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  // 쿠팡 API의 JSON 응답을 읽습니다.
  // 쿠팡 응답을 JSON으로 읽고, JSON이 아닌 오류 응답도 안전하게 처리합니다.
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Coupang API returned non-JSON response: ${response.status}`);
  }

  // 쿠팡 파트너스 API의 정상 응답과 오류 응답 형식을 함께 확인합니다.
  if (!response.ok || (data.rCode !== undefined && data.rCode !== "0")) {
    throw new Error(
      data.rMessage ||
      data.message ||
      data.error ||
      `Coupang API error: ${response.status}`
    );
  }

  return data;
}

// 오늘의 특가, 인기검색, 인기상품, 로켓배송을 목적별로 분리해 반환합니다.
async function loadProducts(env) {
  // 쿠팡 공식 Gold Box 상품을 가져옵니다.
  const goldbox = await coupangRequest("GET", GOLD_BOX_PATH, env);
  const goldboxProducts = Array.isArray(goldbox.data)
    ? goldbox.data
    : Array.isArray(goldbox.data?.productData)
      ? goldbox.data.productData
      : [];

  // Google Trends에서 별도 인기검색 키워드를 가져옵니다.
  const trendKeywords = await loadTrendingKeywords();

  // 인기검색어별로 쿠팡 공식 상품 검색 API를 호출합니다.
  const trendingRaw = [];
  for (const keyword of trendKeywords.slice(0, 5)) {
    try {
      const query = `?keyword=${encodeURIComponent(keyword)}&limit=2`;
      const result = await coupangRequest("GET", SEARCH_PATH + query, env);
      const products = Array.isArray(result.data?.productData) ? result.data.productData : [];
      trendingRaw.push(...products.map((item) => ({ ...item, trendKeyword: keyword })));
    } catch (error) {
      console.error("보고팡 인기검색 상품 조회 실패:", keyword, error.message);
    }
  }

  // 각 탭 내부에서만 상품 ID 기준으로 중복을 제거합니다.
  const uniqueById = (products) => {
    const unique = [];
    const seen = new Set();

    for (const item of products) {
      const key = String(item.productId || item.productUrl || item.productName);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    return unique;
  };

  // 공식 데이터가 없는 '인기상품'은 임의로 만들지 않습니다.
  const popularRaw = [];

  // 로켓배송은 Coupang API의 공식 isRocket 필드만 사용합니다.
  const rocketRaw = uniqueById([...goldboxProducts, ...trendingRaw])
    .filter((item) => item.isRocket === true);

  // 모든 탭의 상품을 합쳐 한 번에 딥링크로 변환합니다.
  const allRaw = uniqueById([...goldboxProducts, ...trendingRaw, ...popularRaw, ...rocketRaw]);
  const converted = [];

  for (let i = 0; i < allRaw.length; i += 50) {
    const batch = allRaw.slice(i, i + 50);
    const urls = batch
      .map((item) => item.productId
        ? `https://www.coupang.com/vp/products/${item.productId}`
        : item.productUrl)
      .filter(Boolean);

    if (!urls.length) continue;

    try {
      const deeplink = await coupangRequest(
        "POST",
        DEEPLINK_PATH,
        env,
        { coupangUrls: urls }
      );

      for (const link of deeplink.data || []) {
        const partnerUrl = link.shortenUrl || link.landingUrl;
        if (partnerUrl) converted.push([link.originalUrl, partnerUrl]);
      }
    } catch (error) {
      console.error("보고팡 딥링크 배치 변환 실패:", error.message);
    }
  }

  const linkMap = new Map(converted);

  // 개별 상품을 사이트에서 사용하는 공통 구조로 변환합니다.
  const toSiteProduct = (item, source) => {
    const canonicalUrl = item.productId
      ? `https://www.coupang.com/vp/products/${item.productId}`
      : item.productUrl;
    const partnerUrl = linkMap.get(canonicalUrl) || linkMap.get(item.productUrl);

    if (!partnerUrl) return null;

    return {
      id: String(item.productId || item.productUrl || item.productName),
      name: item.productName,
      price: item.productPrice,
      originalPrice: item.originalPrice ?? item.productOriginalPrice ?? item.listPrice ?? null,
      discountRate: item.discountRate ?? item.discountRatePercent ?? null,
      image: item.productImage,
      category: item.categoryName || "기타",
      rocket: Boolean(item.isRocket),
      keyword: item.trendKeyword || null,
      source,
      url: partnerUrl
    };
  };

  return {
    specialDeals: uniqueById(goldboxProducts)
      .map((item) => toSiteProduct(item, "오늘의 특가"))
      .filter(Boolean),
    trendingSearch: uniqueById(trendingRaw)
      .map((item) => toSiteProduct(item, "인기검색"))
      .filter(Boolean),
    popularProducts: uniqueById(popularRaw)
      .map((item) => toSiteProduct(item, "인기상품"))
      .filter(Boolean),
    rocketProducts: rocketRaw
      .map((item) => toSiteProduct(item, "로켓배송"))
      .filter(Boolean)
  };
}

// 별도 인기검색 데이터에서 한국의 오늘 인기 검색어를 가져옵니다.
async function loadTrendingKeywords() {
  try {
    // Google Trends의 한국 일간 인기 검색 RSS를 읽습니다.
    const response = await fetch(TREND_RSS_URL);
    if (!response.ok) throw new Error(`Trend source error: ${response.status}`);

    const xml = await response.text();
    const keywords = [];
    const itemMatches = xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/g);

    for (const match of itemMatches) {
      const keyword = decodeXml(match[1]).trim();
      if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
    }

    return keywords.slice(0, 10);
  } catch (error) {
    // 인기검색 소스가 일시적으로 실패해도 Gold Box는 정상적으로 표시합니다.
    console.error("보고팡 인기검색 데이터 실패:", error.message);
    return [];
  }
}

// XML에서 사용하는 기본 특수문자를 복원합니다.
function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// 상품 데이터를 1시간 캐시해 쿠팡 가격 변경을 하루 종일 늦게 반영하는 문제를 줄입니다.
async function getProductsResponse(env, ctx) {
  const request = new Request(CACHE_URL, { method: "GET" });
  const cache = caches.default;

  // 먼저 기존 상품 데이터를 확인합니다.
  const cached = await cache.match(request);
  if (cached) {
    // 구조 변경 전의 배열 캐시가 남아 있으면 새 구조로 다시 생성합니다.
    try {
      const cachedData = await cached.clone().json();
      if (
        cachedData &&
        !Array.isArray(cachedData) &&
        Array.isArray(cachedData.specialDeals) &&
        Array.isArray(cachedData.trendingSearch) &&
        Array.isArray(cachedData.popularProducts) &&
        Array.isArray(cachedData.rocketProducts)
      ) {
        return cached;
      }
    } catch {
      // 잘못된 캐시는 무시하고 최신 데이터를 다시 생성합니다.
    }
  }

  // 캐시가 없거나 이전 구조의 캐시라면 쿠팡에서 새 상품을 가져옵니다.
  try {
    const products = await loadProducts(env);
    const response = new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600"
      }
    });

    // 다음 요청에서 같은 데이터를 재사용합니다.
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch (error) {
    console.error("보고팡 쿠팡 API 오류:", error);

    return new Response(
      JSON.stringify({ error: `쿠팡 상품 정보를 가져오지 못했습니다: ${error.message}` }),
      {
        status: 502,
        headers: { "Content-Type": "application/json; charset=UTF-8" }
      }
    );
  }
}

// 매일 오전 7시 스케줄에서 상품 캐시를 새 데이터로 교체합니다.
async function refreshProducts(env) {
  const cache = caches.default;
  const request = new Request(CACHE_URL, { method: "GET" });

  try {
    const products = await loadProducts(env);
    const response = new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600"
      }
    });

    // 기존 캐시를 오늘의 상품 데이터로 덮어씁니다.
    await cache.put(request, response);
    console.log("보고팡 상품 일일 갱신 완료:", new Date().toISOString());
  } catch (error) {
    console.error("보고팡 일일 갱신 실패:", error);
  }
}
