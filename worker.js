import { DurableObject } from "cloudflare:workers";
import { sendPushBatch } from "@mmmike/web-push/send";

// 보고팡 Cloudflare Worker입니다.
// Git 연동 자동 배포 연결 확인용 최신 버전입니다.
// 외부 트렌드로 관심 키워드를 먼저 선정한 뒤 쿠팡 상품을 수집하고 캐시합니다.
// 쿠팡 파트너스 API를 서버에서 호출해 API 키를 브라우저에 노출하지 않습니다.

const COUPANG_DOMAIN = "https://api-gateway.coupang.com";
const GOLD_BOX_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/goldbox?limit=100&imageSize=300x300";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
const SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/search";
const TREND_RSS_URL = "https://trends.google.com/trending/rss?geo=KR";
const TREND_KEYWORD_LIMIT = 8;
const TREND_KEYWORD_CANDIDATE_LIMIT = 12;
const MIN_TRENDING_PRODUCTS = 8;
const COUPANG_SEARCH_PRODUCT_LIMIT = 4;
const FALLBACK_SEARCH_KEYWORDS = ["생활용품", "주방용품", "식품", "가전", "디지털"];
const GENERAL_DEAL_SEARCH_KEYWORDS = [
  "생활용품", "주방용품", "식품", "가전", "디지털",
  "패션", "뷰티", "스포츠", "유아", "반려동물",
  "생필품", "청소용품", "수납용품", "건강용품", "캠핑용품", "문구"
];
const GENERAL_DEAL_TARGET = 20;
const GENERAL_DEAL_SEARCH_LIMIT = 10;
// 할인율 데이터 구조가 변경된 기존 캐시를 즉시 무효화하기 위한 캐시 버전입니다.
const CACHE_URL = "https://bogopang.tcflick.com/api/products?v=general-deals-v2";

// 쿠팡 상품은 가격과 특가 상태가 변할 수 있으므로 하루 1회보다 자주 갱신합니다.
// 6시간 간격으로 갱신해 최신성과 API 호출량 사이의 균형을 유지합니다.
const REFRESH_INTERVAL_SECONDS = 3 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 수동 갱신 요청은 쿠팡에서 최신 상품을 다시 받아 캐시를 교체합니다.
    if (url.pathname === "/api/refresh" && request.method === "POST") {
      const refreshKey = String(env.REFRESH_KEY || "").trim();
      const providedKey = request.headers.get("X-Refresh-Key") || "";

      if (!refreshKey || providedKey !== refreshKey) {
        return new Response(JSON.stringify({ ok: false, error: "갱신 권한이 없습니다." }), {
          status: 403,
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      }

      try {
        const result = await refreshProducts(env);
        return new Response(JSON.stringify({ ok: true, productCount: result.productCount, message: "상품 갱신 완료" }), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      }
    }

    // 상품 알림의 VAPID 공개키를 반환합니다. 비밀키는 브라우저에 노출하지 않습니다.
    if (url.pathname === "/api/alerts/public-key" && request.method === "GET") {
      return jsonResponse({ publicKey: String(env.VAPID_PUBLIC_KEY || "").trim() });
    }

    // 상품 알림 관련 요청은 Durable Object에 저장합니다.
    if (url.pathname.startsWith("/api/alerts")) {
      return handleAlertRequest(request, env);
    }

    // 상품 API 요청은 목적별 상품 데이터를 가져와 1시간 캐시합니다.
    if (url.pathname === "/api/products") {
      return getProductsResponse(env, ctx);
    }

    // 나머지 요청은 public 폴더의 정적 사이트를 반환합니다.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    // Cron이 활성화된 환경에서만 예약 갱신을 실행합니다.
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

// 쿠팡 API 가격 값을 숫자로 안전하게 정규화합니다.
function normalizePrice(value) {
  const normalized = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

// 쿠팡 API가 실제로 제공한 할인율만 정수 퍼센트로 정규화합니다.
function normalizeDiscountRate(value) {
  const normalized = Number(String(value ?? "").replace(/,/g, "").replace(/%$/, "").trim());
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 100) return null;
  return normalized > 0 && normalized < 1 ? Math.round(normalized * 100) : Math.round(normalized);
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
  if (!response.ok || (data.rCode !== undefined && String(data.rCode) !== "0")) {
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
  const stats = {
    trends: 0,
    search: 0,
    searchKeywords: 0,
    goldbox: 0,
    combined: 0,
    deeplinkRequested: 0,
    deeplinkResponseCount: 0,
    deeplinkUsableCount: 0,
    deeplinkMatched: 0,
    missingPartnerUrl: 0,
    invalidProduct: 0,
    final: 0
  };

  // Gold Box 실패가 전체 상품 수집 실패로 이어지지 않도록 독립적으로 처리합니다.
  let goldboxProducts = [];
  try {
    const goldbox = await coupangRequest("GET", GOLD_BOX_PATH, env);
    goldboxProducts = Array.isArray(goldbox.data)
      ? goldbox.data
      : Array.isArray(goldbox.data?.productData)
        ? goldbox.data.productData
        : [];
    stats.goldbox = goldboxProducts.length;
    console.log("보고팡 Gold Box 상품 수:", goldboxProducts.length);
  } catch (error) {
    console.error("보고팡 Gold Box 조회 실패:", error.message);
  }

  // 외부 트렌드에서 상품과 연결하기 좋은 후보를 먼저 선정합니다.
  const trendSignals = await loadTrendSignals(env);
  stats.trends = trendSignals.filter((signal) => !signal.isFallback).length;

  // 트렌드가 모두 비상품성 키워드인 날에도 실제 쿠팡 상품 수집이 멈추지 않도록
  // 별도의 고정 상품 검색어를 fallback으로 사용합니다. fallback은 실제 상품 데이터가 아닙니다.
  const searchSignals = trendSignals.length
    ? trendSignals.slice(0, TREND_KEYWORD_CANDIDATE_LIMIT)
    : FALLBACK_SEARCH_KEYWORDS.map((keyword) => ({
        keyword,
        source: "기본 상품 탐색",
        isFallback: true
      }));

  const trendingRaw = [];
  const usedSignals = [];
  const productIdentity = (item) =>
    String(item.productId || item.productUrl || item.productName || "");

  const countUniqueProducts = () => {
    const seen = new Set();
    for (const item of trendingRaw) {
      const key = productIdentity(item);
      if (key) seen.add(key);
    }
    return seen.size;
  };

  for (const signal of searchSignals) {
    if (
      usedSignals.length >= TREND_KEYWORD_LIMIT ||
      countUniqueProducts() >= MIN_TRENDING_PRODUCTS
    ) {
      break;
    }

    try {
      const query =
        `?keyword=${encodeURIComponent(signal.keyword)}&limit=${COUPANG_SEARCH_PRODUCT_LIMIT}`;
      const result = await coupangRequest("GET", SEARCH_PATH + query, env);
      const products = Array.isArray(result.data?.productData)
        ? result.data.productData
        : Array.isArray(result.data)
          ? result.data
          : [];

      console.log("보고팡 트렌드 검색 상품 수:", signal.keyword, products.length);
      stats.searchKeywords += 1;
      stats.search += products.length;
      usedSignals.push(signal);

      trendingRaw.push(
        ...products.map((item) => ({
          ...item,
          trendKeyword: signal.keyword,
          trendKeywords: [signal.keyword],
          trendSource: signal.source,
          trendIsFallback: Boolean(signal.isFallback)
        }))
      );
    } catch (error) {
      console.error("보고팡 트렌드 상품 조회 실패:", signal.keyword, error.message);
    }
  }

  // 트렌드 키워드는 있었지만 쿠팡 검색 결과가 하나도 없으면
  // 별도의 상품 검색어로 다시 시도해 수집 전체가 0개가 되는 것을 방지합니다.
  if (!trendingRaw.length && trendSignals.length) {
    for (const keyword of FALLBACK_SEARCH_KEYWORDS.slice(0, 3)) {
      try {
        const query =
          `?keyword=${encodeURIComponent(keyword)}&limit=${COUPANG_SEARCH_PRODUCT_LIMIT}`;
        const result = await coupangRequest("GET", SEARCH_PATH + query, env);
        const products = Array.isArray(result.data?.productData)
          ? result.data.productData
          : Array.isArray(result.data)
            ? result.data
            : [];

        stats.searchKeywords += 1;
        stats.search += products.length;
        usedSignals.push({
          keyword,
          source: "기본 상품 탐색",
          isFallback: true
        });

        trendingRaw.push(
          ...products.map((item) => ({
            ...item,
            trendKeyword: keyword,
            trendKeywords: [keyword],
            trendSource: "기본 상품 탐색",
            trendIsFallback: true
          }))
        );

        if (trendingRaw.length >= MIN_TRENDING_PRODUCTS) break;
      } catch (error) {
        console.error("보고팡 fallback 상품 조회 실패:", keyword, error.message);
      }
    }
  }

  // 오늘의 특가 전용 검색입니다.
  // Google Trends 결과가 없거나 할인 상품이 부족한 날에도 특가 후보를 확보하기 위해
  // 공식 Coupang Search API를 별도로 조회합니다. Gold Box는 아래 최종 필터에서 제외합니다.
  const generalDealRaw = [];
  const dealSearchSeen = new Set();

  const isDiscountedRawProduct = (item) => {
    const price = normalizePrice(item.productPrice);
    const originalPrice = normalizePrice(
      item.originalPrice ?? item.productOriginalPrice ?? item.listPrice
    );
    const discountRate = normalizeDiscountRate(item.discountRate);

    return Boolean(
      (originalPrice != null && price != null && originalPrice > price) ||
      (discountRate != null && discountRate > 0)
    );
  };

  for (const keyword of GENERAL_DEAL_SEARCH_KEYWORDS) {
    if (generalDealRaw.length >= GENERAL_DEAL_TARGET) break;

    try {
      const query =
        `?keyword=${encodeURIComponent(keyword)}&limit=${GENERAL_DEAL_SEARCH_LIMIT}`;
      const result = await coupangRequest("GET", SEARCH_PATH + query, env);
      const products = Array.isArray(result.data?.productData)
        ? result.data.productData
        : Array.isArray(result.data)
          ? result.data
          : [];

      stats.searchKeywords += 1;
      stats.search += products.length;

      for (const item of products) {
        const key = productIdentity(item);
        if (!key || dealSearchSeen.has(key) || !isDiscountedRawProduct(item)) continue;
        dealSearchSeen.add(key);
        generalDealRaw.push({
          ...item,
          trendKeyword: null,
          trendKeywords: [],
          trendSource: "쿠팡 할인상품 검색",
          trendIsFallback: true
        });

        if (generalDealRaw.length >= GENERAL_DEAL_TARGET) break;
      }

      console.log(
        "보고팡 일반 특가 검색 상품 수:",
        keyword,
        products.length,
        "할인 후보:",
        generalDealRaw.length
      );
    } catch (error) {
      console.error("보고팡 일반 특가 검색 실패:", keyword, error.message);
    }
  }

  // 상품 ID 기준으로 중복 제거하면서 여러 트렌드 키워드의 연결 정보는 합칩니다.
  const uniqueById = (products) => {
    const unique = [];
    const indexMap = new Map();

    for (const item of products) {
      const key = productIdentity(item);
      if (!key) continue;

      const existingIndex = indexMap.get(key);
      if (existingIndex == null) {
        const keywords = Array.isArray(item.trendKeywords)
          ? [...new Set(item.trendKeywords.filter(Boolean))]
          : item.trendKeyword
            ? [item.trendKeyword]
            : [];

        unique.push({
          ...item,
          trendKeywords: keywords
        });
        indexMap.set(key, unique.length - 1);
        continue;
      }

      const existing = unique[existingIndex];
      const mergedKeywords = [
        ...(Array.isArray(existing.trendKeywords) ? existing.trendKeywords : []),
        ...(Array.isArray(item.trendKeywords) ? item.trendKeywords : []),
        item.trendKeyword || ""
      ].filter(Boolean);

      existing.trendKeywords = [...new Set(mergedKeywords)];
      if (!existing.trendKeyword && item.trendKeyword) {
        existing.trendKeyword = item.trendKeyword;
      }
    }

    return unique;
  };

  // 공식 데이터가 없는 인기순위는 임의로 만들지 않습니다.
  const popularRaw = [];

  // 로켓배송은 쿠팡 공식 isRocket 필드만 사용합니다.
  const rocketRaw = uniqueById([...goldboxProducts, ...trendingRaw])
    .filter((item) => item.isRocket === true);

  // 모든 상품을 통합한 뒤 딥링크를 배치로 한 번에 처리합니다.
  const allRaw = uniqueById([
    ...goldboxProducts,
    ...trendingRaw,
    ...popularRaw,
    ...rocketRaw
  ]);
  stats.combined = allRaw.length;

  // 쿠팡 URL의 표기 차이(query/hash/trailing slash)를 제거해 안전하게 비교합니다.
  const normalizeCoupangUrl = (value) => {
    try {
      const url = new URL(String(value || "").trim());
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      return `${url.hostname.toLowerCase()}${url.pathname}`;
    } catch {
      return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
    }
  };

  // 쿠팡 상품 URL에서 노출 상품 ID를 추출합니다.
  const extractProductId = (value) => {
    const match = String(value || "").match(/\/vp\/products\/(\d+)/i);
    return match ? String(match[1]) : "";
  };

  // Deeplink 요청 당시 상품과 URL을 함께 보존해 응답 매칭을 추적합니다.
  const deeplinkRequests = [];
  const deeplinkRecords = [];

  const addDeeplinkRecords = (links) => {
    const responseLinks = Array.isArray(links)
      ? links
      : Array.isArray(links?.data)
        ? links.data
        : [];

    for (const link of responseLinks) {
      const originalUrl = String(link?.originalUrl || "").trim();
      stats.deeplinkResponseCount += 1;
      const partnerUrl = String(link?.shortenUrl || link?.landingUrl || "").trim();

      // 실제 제휴 URL이 없는 응답은 해당 상품만 제외하고 원인을 집계합니다.
      if (!partnerUrl) {
        continue;
      }

      stats.deeplinkUsableCount += 1;
      deeplinkRecords.push({
        originalUrl,
        partnerUrl,
        productId: extractProductId(originalUrl),
        normalizedUrl: normalizeCoupangUrl(originalUrl)
      });
    }
  };

  for (let i = 0; i < allRaw.length; i += 50) {
    const batch = allRaw.slice(i, i + 50);
    const requestRecords = batch
      .map((item) => {
        const deeplinkRequestUrl = item.productUrl || (
          item.productId
            ? `https://www.coupang.com/vp/products/${item.productId}`
            : ""
        );

        if (!deeplinkRequestUrl) return null;

        return {
          productId: String(item.productId || "").trim(),
          sourceProductUrl: String(item.productUrl || "").trim(),
          deeplinkRequestUrl
        };
      })
      .filter(Boolean);

    if (!requestRecords.length) continue;

    const urls = requestRecords.map((record) => record.deeplinkRequestUrl);
    deeplinkRequests.push(...requestRecords);
    stats.deeplinkRequested += requestRecords.length;

    try {
      const deeplink = await coupangRequest(
        "POST",
        DEEPLINK_PATH,
        env,
        { coupangUrls: urls }
      );

      addDeeplinkRecords(deeplink.data);
    } catch (error) {
      console.error("보고팡 딥링크 배치 변환 실패:", error.message);

      // 배치 변환이 실패한 경우에만 개별 변환으로 재시도합니다.
      for (const record of requestRecords) {
        try {
          const single = await coupangRequest(
            "POST",
            DEEPLINK_PATH,
            env,
            { coupangUrls: [record.deeplinkRequestUrl] }
          );

          addDeeplinkRecords(single.data);
        } catch (singleError) {
          console.error(
            "보고팡 개별 딥링크 변환 실패:",
            record.deeplinkRequestUrl,
            singleError.message
          );
        }
      }
    }
  }

  // 동일한 딥링크 응답이 중복으로 들어와도 한 번만 사용합니다.
  const linkByProductId = new Map();
  const linkByNormalizedUrl = new Map();
  const linkByOriginalUrl = new Map();

  for (const record of deeplinkRecords) {
    if (record.originalUrl) {
      linkByOriginalUrl.set(record.originalUrl, record.partnerUrl);
      linkByNormalizedUrl.set(record.normalizedUrl, record.partnerUrl);
    }
    if (record.productId) {
      linkByProductId.set(record.productId, record.partnerUrl);
    }
  }

  // Deeplink originalUrl이 달라져도 실제 요청 목록에서 같은 상품을 찾을 수 있게 합니다.
  const requestedByProductId = new Map();
  const requestedByNormalizedUrl = new Map();
  const requestedByOriginalUrl = new Map();

  for (const record of deeplinkRequests) {
    if (record.productId) {
      requestedByProductId.set(record.productId, record);
    }
    requestedByNormalizedUrl.set(
      normalizeCoupangUrl(record.deeplinkRequestUrl),
      record
    );
    requestedByOriginalUrl.set(record.deeplinkRequestUrl, record);
  }

  // 상품마다 productId → originalUrl의 productId → normalized URL → exact URL 순으로 연결합니다.
  const findPartnerUrl = (item) => {
    const productId = String(item.productId || "").trim();
    const productUrl = String(item.productUrl || "").trim();
    const canonicalUrl = productId
      ? `https://www.coupang.com/vp/products/${productId}`
      : productUrl;

    // 1순위: Deeplink 응답의 productId가 직접 일치하는 경우
    if (productId && linkByProductId.has(productId)) {
      return linkByProductId.get(productId);
    }

    // 2순위: 실제 요청 목록에서 상품을 찾은 뒤 그 요청 URL에 대한 Deeplink를 찾습니다.
    const requested =
      (productId && requestedByProductId.get(productId)) ||
      requestedByNormalizedUrl.get(normalizeCoupangUrl(productUrl)) ||
      requestedByNormalizedUrl.get(normalizeCoupangUrl(canonicalUrl)) ||
      requestedByOriginalUrl.get(productUrl) ||
      requestedByOriginalUrl.get(canonicalUrl);

    if (requested) {
      const requestedProductId = requested.productId;
      if (requestedProductId && linkByProductId.has(requestedProductId)) {
        return linkByProductId.get(requestedProductId);
      }

      const normalizedRequest = normalizeCoupangUrl(requested.deeplinkRequestUrl);
      return (
        linkByNormalizedUrl.get(normalizedRequest) ||
        linkByOriginalUrl.get(requested.deeplinkRequestUrl) ||
        ""
      );
    }

    return (
      linkByNormalizedUrl.get(normalizeCoupangUrl(productUrl)) ||
      linkByNormalizedUrl.get(normalizeCoupangUrl(canonicalUrl)) ||
      linkByOriginalUrl.get(productUrl) ||
      linkByOriginalUrl.get(canonicalUrl) ||
      ""
    );
  };

  // 쿠팡 원본 데이터를 보고팡 공통 상품 구조로 변환합니다.
  const toSiteProduct = (item, source) => {
    const partnerUrl = findPartnerUrl(item);
    const productUrl = String(item.productUrl || "").trim();

    // Deeplink가 없어도 정상적인 쿠팡 상품은 표시합니다.
    // 제휴 링크가 없다는 사실은 진단 통계로만 기록하고 상품을 탈락시키지 않습니다.
    if (!partnerUrl) {
      stats.missingPartnerUrl += 1;
    } else {
      stats.deeplinkMatched += 1;
    }

    // 쿠팡 Open API의 실제 상품 가격 필드는 productPrice를 판매가격으로 사용합니다.
    const price = normalizePrice(item.productPrice);
    if (
      (!item.productId && !item.productUrl) ||
      !item.productName ||
      !Number.isFinite(price) ||
      !item.productImage
    ) {
      stats.invalidProduct += 1;
      return null;
    }

    const trendKeywords = Array.isArray(item.trendKeywords)
      ? [...new Set(item.trendKeywords.filter(Boolean))]
      : item.trendKeyword
        ? [item.trendKeyword]
        : [];

    // 쿠팡 Open API에서 실제로 제공되는 할인 전 가격(originalPrice)을 사용합니다.
    // originalPrice가 판매가보다 높을 때만 가격 기준으로 할인율을 계산합니다.
    const isGeneralDeal = source === "오늘의 특가";
    const originalPriceCandidates = [
      item.originalPrice,
      item.productOriginalPrice,
      item.listPrice
    ];
    const originalPrice = isGeneralDeal
      ? null
      : originalPriceCandidates
          .map(normalizePrice)
          .find((value) => value != null) ?? null;
    const calculatedDiscountRate =
      originalPrice != null && originalPrice > price
        ? Math.round(((originalPrice - price) / originalPrice) * 100)
        : null;

    // 오늘의 특가는 할인율/정상가의 신뢰성을 보장할 수 없어 표시하지 않습니다.
    // 와우회원 특가 등 다른 영역은 API에 실제 정보가 있는 경우에만 표시합니다.
    const apiDiscountRate = normalizeDiscountRate(item.discountRate);
    const discountRate = isGeneralDeal
      ? null
      : apiDiscountRate != null
        ? apiDiscountRate
        : calculatedDiscountRate;

    return {
      id: String(item.productId || item.productUrl || item.productName),
      name: item.productName,
      price,
      originalPrice,
      discountRate,
      image: item.productImage,
      category: item.categoryName || "기타",
      rocket: Boolean(item.isRocket),
      keyword: trendKeywords[0] || null,
      trendKeywords,
      trendSource: item.trendSource || null,
      source,
      url: partnerUrl || productUrl
    };
  };

  // 일반 오늘의 특가는 Gold Box를 사용하지 않고 Search API 결과 중
  // 실제 할인 정보가 확인되는 상품만 사용합니다.
  const goldboxIds = new Set(
    goldboxProducts.map((item) => productIdentity(item)).filter(Boolean)
  );
  const specialDealCandidates = uniqueById(generalDealRaw);
  const generalDealRawFiltered = specialDealCandidates.filter((item) => {
    const key = productIdentity(item);
    if (!key || goldboxIds.has(key)) return false;

    const price = normalizePrice(item.productPrice);
    const originalPrice = normalizePrice(
      item.originalPrice ?? item.productOriginalPrice ?? item.listPrice
    );
    const discountRate = normalizeDiscountRate(item.discountRate);

    return Boolean(
      (originalPrice != null && price != null && originalPrice > price) ||
      (discountRate != null && discountRate > 0)
    );
  });

  // 쿠팡 Search API가 할인 전 가격/할인율을 제공하지 않는 경우에도
  // 일반 특가 탭이 빈 화면이 되지 않도록 Gold Box를 제외한 검색 상품을 fallback으로 사용합니다.
  // fallback 상품에는 할인율을 추정하거나 임의로 붙이지 않습니다.
  const generalSearchFallback = uniqueById([...generalDealRaw, ...trendingRaw])
    .filter((item) => {
      const key = productIdentity(item);
      return Boolean(key) && !goldboxIds.has(key);
    });

  const selectedGeneralDeals = generalDealRawFiltered.length
    ? generalDealRawFiltered
    : generalSearchFallback;

  const specialDeals = selectedGeneralDeals
    .map((item) => toSiteProduct(item, "오늘의 특가"))
    .filter(Boolean)
    .slice(0, GENERAL_DEAL_TARGET);

  const wowDeals = uniqueById(goldboxProducts)
    .map((item) => toSiteProduct(item, "와우회원 전용 특가"))
    .filter(Boolean);

  const trendingSearch = uniqueById(trendingRaw)
    .map((item) => toSiteProduct(item, "오늘의 관심 키워드"))
    .filter(Boolean);

  const rocketProducts = rocketRaw
    .map((item) => toSiteProduct(item, "로켓배송"))
    .filter(Boolean);

  const products = [...specialDeals, ...wowDeals, ...trendingSearch, ...rocketProducts];

  stats.final = products.length;
  const collectionStats = {
    trends: stats.trends,
    searchKeywords: stats.searchKeywords,
    searchProducts: stats.search,
    goldbox: stats.goldbox,
    combined: stats.combined,
    deeplinkRequested: stats.deeplinkRequested,
    deeplinkResponseCount: stats.deeplinkResponseCount,
    deeplinkUsableCount: stats.deeplinkUsableCount,
    deeplinkMatched: stats.deeplinkMatched,
    missingPartnerUrl: stats.missingPartnerUrl,
    invalidProduct: stats.invalidProduct,
    final: stats.final
  };

  console.log("보고팡 상품 수집 단계:", collectionStats);

  // 어느 단계에서 상품이 사라졌는지 바로 확인할 수 있도록 0단계를 명시합니다.
  for (const [stage, count] of Object.entries(collectionStats)) {
    if (count === 0) {
      console.warn(`[보고팡] ${stage}=0`);
    }
  }

  if (stats.deeplinkRequested > 0 && stats.deeplinkResponseCount === 0) {
    console.error("[보고팡] Deeplink 요청은 있었지만 응답 레코드가 0개입니다.");
  }

  if (stats.deeplinkResponseCount > 0 && stats.deeplinkUsableCount === 0) {
    console.error("[보고팡] Deeplink 응답은 있지만 사용 가능한 제휴 URL이 0개입니다.");
  }

  if (stats.deeplinkUsableCount > 0 && stats.deeplinkMatched === 0) {
    console.error("[보고팡] Deeplink 응답은 존재하지만 상품과 제휴 링크 연결에 모두 실패했습니다.");
  }

  if (stats.final === 0) {
    console.error("[보고팡] 최종 상품이 0개입니다.", collectionStats);
  }

  if (!products.length) {
    throw new Error("쿠팡 API에서 사용할 수 있는 상품이 0개입니다.");
  }

  return {
    specialDeals,
    wowDeals,
    trendingSearch,
    popularProducts: [],
    rocketProducts,

    // 실제로 검색에 사용한 외부 트렌드 키워드와 출처만 저장합니다.
    trendKeywords: usedSignals
      .filter((signal) => !signal.isFallback)
      .map((signal) => ({
        keyword: signal.keyword,
        source: signal.source
      }))
  };
}
// 외부 트렌드 소스를 모아 상품 탐색용 키워드를 만듭니다.
async function loadTrendSignals(env) {
  // Google Trends 대한민국 최근 24시간 후보를 가져옵니다.
  const googleKeywords = await loadGoogleTrendingKeywords();

  // 상품과 직접 연결하기 어려운 뉴스/인물/정치/경기성 검색어를 우선 제외합니다.
  const productKeywords = selectProductTrendKeywords(googleKeywords);

  // 상품성 후보가 부족하면 그 수만 사용하고, 관련 없는 원본 트렌드를 상품 검색에 억지로 연결하지 않습니다.
  const selectedKeywords = productKeywords.slice(0, TREND_KEYWORD_CANDIDATE_LIMIT);

  if (!selectedKeywords.length && googleKeywords.length) {
    console.warn("보고팡: 오늘 Google Trends에는 상품성 키워드가 없습니다. 기본 상품 검색 fallback을 사용합니다.");
  }

  // 네이버 DataLab 자격증명이 있으면 선정 후보를 추가 교차검증합니다.
  const naverRatios = await loadNaverTrendRatios(selectedKeywords, env);

  return selectedKeywords
    .map((keyword) => ({
      keyword,
      source: naverRatios.has(keyword)
        ? "Google Trends · Naver DataLab"
        : "Google Trends"
    }))
    .sort((a, b) => {
      const aRatio = naverRatios.get(a.keyword);
      const bRatio = naverRatios.get(b.keyword);

      if (aRatio == null && bRatio == null) return 0;
      if (aRatio == null) return 1;
      if (bRatio == null) return -1;
      return bRatio - aRatio;
    });
}

// 상품 구매 검색으로 연결하기 좋은 트렌드인지 규칙으로 판별합니다.
function selectProductTrendKeywords(keywords) {
  // 상품과 직접 연결하기 어려운 이슈형 검색어는 제외합니다.
  const excludedPatterns = [
    /정치|대통령|국회|선거|후보|정당|총선|대선|의원|장관|공약|입법|탄핵/,
    /사건|사고|사망|체포|구속|재판|판결|폭행|범죄|사기|피싱|논란|속보|뉴스|기자회견/,
    /축구|야구|농구|배구|테니스|골프.*경기|경기결과|플레이오프|월드컵|올림픽|금메달|선수|감독|득점|승리/,
    /배우|가수|아이돌|연예|방송|드라마|영화|예능|열애|결혼|이혼|미스코리아|아나운서|가요|컴백/,
    /주가|증시|공매도|우선주|코인|비트코인|환율|금리|주식|상장/,
    /날씨|태풍|지진|폭염|폭설|미세먼지|기상/
  ];

  // 쿠팡 상품 검색으로 연결하기 쉬운 카테고리 키워드입니다.
  const productPatterns = [
    /식품|음식|과일|채소|고기|육류|수산|간식|라면|과자|커피|차|음료|우유|치즈|빵|떡|김치|밀키트/,
    /세제|휴지|생필품|주방|청소|수납|정리|가구|침대|의자|책상|조명|인테리어|욕실|생활용품/,
    /가전|에어컨|선풍기|냉장고|세탁기|건조기|청소기|전자레인지|노트북|컴퓨터|모니터|키보드|마우스|스마트폰|아이폰|갤럭시|이어폰|충전기|태블릿|카메라/,
    /옷|의류|패션|드레스|원피스|셔츠|티셔츠|바지|자켓|코트|신발|운동화|구두|가방|지갑|시계|안경|악세사리|주얼리/,
    /화장품|뷰티|샴푸|린스|트리트먼트|스킨|로션|크림|선크림|향수|면도|헤어|단발|메이크업/,
    /캠핑|텐트|여행|캐리어|등산|낚시|골프|자전거|운동|헬스|요가|러닝|취미|문구|게임|장난감|등산용품/,
    /육아|유아|아기|기저귀|분유|유모차|반려|강아지|고양이|사료|펫|반려동물/,
    /건강|혈당|콜레스테롤|영양|비타민|프로틴|마사지|안마|건강관리/
  ];

  // 일반적인 구매 의도가 포함된 키워드는 상품 검색 후보로 허용합니다.
  const genericCommercePatterns = [
    /할인|세일|쿠폰|가격|구매|쇼핑|선물|신상|신제품|용품|제품|브랜드/
  ];

  return [...new Set(
    keywords.filter((keyword) => {
      const normalized = String(keyword || "").trim();
      if (!normalized || normalized.length > 80) return false;
      if (excludedPatterns.some((pattern) => pattern.test(normalized))) return false;

      if (productPatterns.some((pattern) => pattern.test(normalized))) return true;
      if (genericCommercePatterns.some((pattern) => pattern.test(normalized))) return true;

      // 카테고리/상거래 단서가 없는 일반 검색어는 상품 검색에 사용하지 않습니다.
      // 인물명·스포츠 선수명 같은 일반 급상승어가 쿠팡 검색으로 넘어가는 것을 막습니다.
      return false;
    })
  )];
}

// // Google Trends 대한민국 RSS에서 최근 인기 검색어를 가져옵니다.
async function loadGoogleTrendingKeywords() {
  try {
    const response = await fetch(TREND_RSS_URL);
    if (!response.ok) {
      throw new Error(`Google Trends error: ${response.status}`);
    }

    const xml = await response.text();
    const keywords = [];
    const itemMatches = xml.matchAll(
      /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/g
    );

    for (const match of itemMatches) {
      const keyword = decodeXml(match[1]).trim();
      if (keyword && !keywords.includes(keyword)) {
        keywords.push(keyword);
      }
    }

    return keywords.slice(0, 20);
  } catch (error) {
    console.error("보고팡 Google Trends 데이터 실패:", error.message);
    return [];
  }
}

// 네이버 DataLab 검색어 트렌드가 설정된 경우 Google 후보를 교차검증합니다.
async function loadNaverTrendRatios(keywords, env) {
  const clientId = String(env.NAVER_CLIENT_ID || "").trim();
  const clientSecret = String(env.NAVER_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret || !keywords.length) {
    return new Map();
  }

  try {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 6);

    const body = {
      startDate: start.toISOString().slice(0, 10),
      endDate: today.toISOString().slice(0, 10),
      timeUnit: "date",
      keywordGroups: keywords.slice(0, 5).map((keyword) => ({
        groupName: keyword,
        keywords: [keyword]
      }))
    };

    const response = await fetch("https://openapi.naver.com/v1/datalab/search", {
      method: "POST",
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Naver DataLab error: ${response.status}`);
    }

    const data = await response.json();
    const ratios = new Map();

    for (const result of data.results || []) {
      const latest = Array.isArray(result.data) && result.data.length
        ? result.data[result.data.length - 1]
        : null;

      if (latest && Number.isFinite(Number(latest.ratio))) {
        ratios.set(result.title, Number(latest.ratio));
      }
    }

    return ratios;
  } catch (error) {
    console.error("보고팡 Naver DataLab 데이터 실패:", error.message);
    return new Map();
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

// 상품 데이터에 실제 표시 가능한 상품이 있는지 확인합니다.
function hasProducts(data) {
  if (!data || Array.isArray(data)) return false;
  return ["specialDeals", "wowDeals", "trendingSearch", "rocketProducts"]
    .some((key) => Array.isArray(data[key]) && data[key].length > 0);
}

// 상품 데이터를 1시간 캐시해 쿠팡 가격 변경을 하루 종일 늦게 반영하는 문제를 줄입니다.
async function getProductsResponse(env, ctx) {
  const request = new Request(CACHE_URL, { method: "GET" });
  const cache = caches.default;

  // 먼저 기존 상품 데이터를 확인합니다.
  const cached = await cache.match(request);
  if (cached) {
    try {
      const cachedData = await cached.clone().json();
      if (
        cachedData &&
        !Array.isArray(cachedData) &&
        Array.isArray(cachedData.specialDeals) &&
        Array.isArray(cachedData.trendingSearch) &&
        Array.isArray(cachedData.popularProducts) &&
        Array.isArray(cachedData.rocketProducts) &&
        Array.isArray(cachedData.trendKeywords) &&
        hasProducts(cachedData)
      ) {
        return cached;
      }
    } catch {
      // 잘못된 캐시는 무시하고 최신 데이터를 다시 생성합니다.
    }
  }

  // 캐시가 없거나 비어 있으면 쿠팡에서 새 상품을 가져옵니다.
  try {
    const products = await loadProducts(env);
    const response = new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600"
      }
    });

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

// 수동/예약 갱신은 새 데이터가 실제 상품을 포함할 때만 기존 캐시를 교체합니다.
async function refreshProducts(env) {
  const cache = caches.default;
  const request = new Request(CACHE_URL, { method: "GET" });

  try {
    const products = await loadProducts(env);

    if (!hasProducts(products)) {
      throw new Error("새 상품 데이터가 0개라 기존 캐시를 유지합니다.");
    }

    const response = new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600"
      }
    });

    await cache.put(request, response);

    // 새 상품 데이터가 저장된 직후 조건 알림을 검사합니다.
    await notifyMatchingAlerts(env, products);

    console.log("보고팡 상품 갱신 완료:", new Date().toISOString());
    return {
      productCount:
        products.specialDeals.length +
        products.wowDeals.length +
        products.trendingSearch.length +
        products.rocketProducts.length
    };
  } catch (error) {
    console.error("보고팡 상품 갱신 실패:", error);
    throw error;
  }
}


/* 상품 조건 알림 API와 저장소입니다. */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }
  });
}

function getClientId(request) {
  const value = String(request.headers.get("X-Bogopang-Client-Id") || "").trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(value) ? value : "";
}

async function handleAlertRequest(request, env) {
  if (!env.ALERT_STORE) return jsonResponse({ ok:false, error:"상품 알림 저장소가 준비되지 않았습니다." },503);
  const clientId=getClientId(request);
  if(!clientId) return jsonResponse({ok:false,error:"알림 식별자가 없습니다."},400);
  const stub=env.ALERT_STORE.get(env.ALERT_STORE.idFromName("global"));
  const url=new URL(request.url);
  const target=new URL(url);
  target.pathname=url.pathname.replace(/^\/api\/alerts/,"")||"/";
  return stub.fetch(new Request(target,{method:request.method,headers:request.headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body}));
}

function alertMatchesProduct(alert,item) {
  if(!alert?.active) return false;
  const groups=Array.isArray(alert.groups)?alert.groups:[];
  if(!groups.length) return false;
  const name=String(item.name||"").toLowerCase();
  const category=String(item.category||"").toLowerCase();
  const price=Number(item.price);
  const rocket=item.rocket===true;
  const test=c=>{
    if(c.type==="keyword") return Boolean(String(c.value||"").trim())&&name.includes(String(c.value).trim().toLowerCase());
    if(c.type==="minPrice") return Number.isFinite(price)&&price>=Number(c.value);
    if(c.type==="maxPrice") return Number.isFinite(price)&&price<=Number(c.value);
    if(c.type==="category") return Boolean(String(c.value||"").trim())&&category===String(c.value).trim().toLowerCase();
    if(c.type==="rocket") return rocket===Boolean(c.value);
    return false;
  };
  const results=groups.map(g=>Array.isArray(g.conditions)&&g.conditions.length?g.conditions.every(test):false);
  return alert.groupJoin==="AND"?results.every(Boolean):results.some(Boolean);
}

function normalizeAlertProduct(item) {
  return {
    id:String(item.id||"").trim(), name:String(item.name||"").trim(), price:Number(item.price),
    image:String(item.image||"").trim(), category:String(item.category||"").trim(),
    rocket:item.rocket===true, url:String(item.url||"").trim()
  };
}

async function notifyMatchingAlerts(env,products) {
  if(!env.ALERT_STORE) return;
  const source=[...(products.specialDeals||[]),...(products.wowDeals||[]),...(products.trendingSearch||[]),...(products.rocketProducts||[])];
  const seen=new Set(), unique=[];
  for(const item of source){
    const p=normalizeAlertProduct(item);
    if(!p.id||!p.name||!Number.isFinite(p.price)||seen.has(p.id)) continue;
    seen.add(p.id); unique.push(p);
  }
  if(!unique.length) return;
  const stub=env.ALERT_STORE.get(env.ALERT_STORE.idFromName("global"));
  await stub.fetch("https://alert-store/check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({products:unique})});
}

export class ProductAlertStore extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env); this.sql=ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS clients(client_id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL)`);
  }

  async fetch(request) {
    const url=new URL(request.url);
    try {
      const clientId=String(request.headers.get("X-Bogopang-Client-Id")||"").trim();
      if(request.method==="GET"&&url.pathname==="/list"){
        const row=this.sql.exec("SELECT data FROM clients WHERE client_id = ?",clientId).toArray()[0];
        const data=row?JSON.parse(row.data):{alerts:[],subscription:null};
        return jsonResponse({ok:true,alerts:data.alerts||[]});
      }
      if(request.method==="POST"&&url.pathname==="/save"){
        const body=await request.json(), alert=sanitizeAlert(body.alert), snapshot=sanitizeSnapshot(body.snapshot);
        if(!clientId||!alert)return jsonResponse({ok:false,error:"알림 조건이 올바르지 않습니다."},400);
        const data=await this.readClient(clientId), index=data.alerts.findIndex(a=>a.id===alert.id);
        if(index>=0){
          alert.matches=data.alerts[index].matches||[];
          alert.alertedProductState=data.alerts[index].alertedProductState||{};
          alert.baselineProducts=snapshot;
          alert.baselineAt=Date.now();
          data.alerts[index]=alert;
        } else {
          alert.baselineProducts=snapshot;
          alert.baselineAt=Date.now();
          data.alerts.push(alert);
        }
        await this.writeClient(clientId,data); return jsonResponse({ok:true,alerts:data.alerts});
      }
      if(request.method==="POST"&&url.pathname==="/delete"){
        const body=await request.json(),data=await this.readClient(clientId);
        data.alerts=data.alerts.filter(a=>a.id!==String(body.id||"")); await this.writeClient(clientId,data);
        return jsonResponse({ok:true,alerts:data.alerts});
      }
      if(request.method==="POST"&&url.pathname==="/toggle"){
        const body=await request.json(),data=await this.readClient(clientId);
        const alert=data.alerts.find(a=>a.id===String(body.id||""));
        if(!alert)return jsonResponse({ok:false,error:"알림을 찾을 수 없습니다."},404);
        alert.active=Boolean(body.active); alert.updatedAt=Date.now(); await this.writeClient(clientId,data);
        return jsonResponse({ok:true,alerts:data.alerts});
      }
      if(request.method==="POST"&&url.pathname==="/subscribe"){
        const body=await request.json(),s=body.subscription;
        if(!clientId||!s?.endpoint||!s?.keys?.p256dh||!s?.keys?.auth)return jsonResponse({ok:false,error:"푸시 구독 정보가 올바르지 않습니다."},400);
        if(!/^https:\/\//i.test(String(s.endpoint)))return jsonResponse({ok:false,error:"허용되지 않은 알림 주소입니다."},400);
        const data=await this.readClient(clientId);
        data.subscription={endpoint:String(s.endpoint),expirationTime:s.expirationTime??null,keys:{p256dh:String(s.keys.p256dh),auth:String(s.keys.auth)}};
        await this.writeClient(clientId,data); return jsonResponse({ok:true});
      }
      if(request.method==="DELETE"&&url.pathname==="/subscribe"){
        const data=await this.readClient(clientId);data.subscription=null;await this.writeClient(clientId,data);return jsonResponse({ok:true});
      }
      if(request.method==="POST"&&url.pathname==="/check") return this.checkAlerts((await request.json()).products||[]);
      return jsonResponse({ok:false,error:"알 수 없는 알림 요청입니다."},404);
    } catch(error) {
      console.error("보고팡 상품 알림 저장소 오류:",error);
      return jsonResponse({ok:false,error:error.message||"상품 알림 처리에 실패했습니다."},500);
    }
  }

  async readClient(clientId){
    const row=this.sql.exec("SELECT data FROM clients WHERE client_id = ?",clientId).toArray()[0];
    if(!row)return {alerts:[],subscription:null};
    try{const d=JSON.parse(row.data);return {alerts:Array.isArray(d.alerts)?d.alerts:[],subscription:d.subscription||null}}catch{return {alerts:[],subscription:null}}
  }

  async writeClient(clientId,data){
    this.sql.exec("INSERT OR REPLACE INTO clients(client_id,data,updated_at) VALUES(?,?,?)",clientId,JSON.stringify(data),Date.now());
  }

  async checkAlerts(products){
    const rows=this.sql.exec("SELECT client_id,data FROM clients").toArray();
    let notified=0;
    for(const row of rows){
      const data=JSON.parse(row.data);let changed=false;
      for(const alert of Array.isArray(data.alerts)?data.alerts:[]){
        if(!alert.active)continue;
        const state=alert.alertedProductState||{},matched=[],baseline=new Map((alert.baselineProducts||[]).map(p=>[p.id,p]));
        for(const product of products){
          if(!alertMatchesProduct(alert,product))continue;
          const previous=state[product.id];
          const baselineProduct=baseline.get(product.id);
          const isNewSinceBaseline=!baselineProduct;
          const priceChangedSinceBaseline=Boolean(baselineProduct)&&Number(baselineProduct.price)!==Number(product.price);
          const wasAlreadyTracked=Boolean(previous);
          if((isNewSinceBaseline||priceChangedSinceBaseline)&&(!wasAlreadyTracked||priceChangedSinceBaseline)){
            matched.push(product);
            state[product.id]={price:product.price,alertedAt:Date.now()};
          }
        }
        if(!matched.length)continue;
        alert.alertedProductState=trimAlertedState(state);alert.lastCheckedAt=Date.now();alert.lastMatchedAt=Date.now();
        alert.matches=[...matched.map(p=>({...p,alertId:alert.id,matchedAt:Date.now()})),...(alert.matches||[])].slice(0,20);
        const subscription=data.subscription;
        if(subscription&&String(this.env.VAPID_PRIVATE_KEY||"").trim()){
          try{
            const result=await sendPushBatch([subscription],{
              title:"🔔 원하는 상품이 발견됐어요",
              body:matched.length===1?matched[0].name:matched.slice(0,3).map(p=>p.name).join(" · ")+(matched.length>3?` 외 ${matched.length-3}개`:""),
              url:"/alerts",tag:`bogopang-alert-${alert.id}`
            },{
              publicKey:String(this.env.VAPID_PUBLIC_KEY||"").trim(),
              privateKey:String(this.env.VAPID_PRIVATE_KEY||"").trim(),
              subject:String(this.env.VAPID_SUBJECT||"mailto:admin@bogopang.tcflick.com").trim()
            },{ttl:86400,urgency:"high",concurrency:1});
            if(result.gone.length)data.subscription=null; else notified+=result.delivered;
          }catch(error){console.error("보고팡 Web Push 전송 실패:",error.message||error)}
        }
        changed=true;
      }
      if(changed)await this.writeClient(row.client_id,data);
    }
    return jsonResponse({ok:true,notified});
  }
}

function sanitizeSnapshot(raw){
  if(!Array.isArray(raw)) return [];
  const seen=new Set(), result=[];
  for(const item of raw.slice(0,1000)){
    const id=String(item?.id||"").trim(), name=String(item?.name||"").trim(), price=Number(item?.price);
    if(!id||!name||!Number.isFinite(price)||seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,name,price,
      image:String(item?.image||"").trim(),
      category:String(item?.category||"").trim(),
      rocket:item?.rocket===true,
      url:String(item?.url||"").trim()
    });
  }
  return result;
}

function sanitizeAlert(raw){
  if(!raw||typeof raw!=="object")return null;
  const groups=Array.isArray(raw.groups)?raw.groups.slice(0,20):[];
  const cleanGroups=groups.map(g=>({conditions:(Array.isArray(g?.conditions)?g.conditions.slice(0,20):[]).map(c=>{
    const type=String(c?.type||"");
    if(!["keyword","minPrice","maxPrice","category","rocket"].includes(type))return null;
    if(type==="rocket")return {type,value:Boolean(c.value)};
    if(type==="minPrice"||type==="maxPrice"){const value=Number(c.value);return Number.isFinite(value)&&value>=0?{type,value:Math.round(value)}:null}
    const value=String(c.value||"").trim().slice(0,100);return value?{type,value}:null;
  }).filter(Boolean)})).filter(g=>g.conditions.length);
  if(!cleanGroups.length)return null;
  return {
    id:String(raw.id||crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80)||crypto.randomUUID(),
    name:"상품 알림",
    groups:cleanGroups,
    groupJoin:raw.groupJoin==="AND"?"AND":"OR",
    active:raw.active!==false,
    createdAt:Number(raw.createdAt)||Date.now(),
    updatedAt:Date.now(),
    matches:Array.isArray(raw.matches)?raw.matches.slice(0,20):[],
    alertedProductState:raw.alertedProductState&&typeof raw.alertedProductState==="object"?raw.alertedProductState:{},
    baselineProducts:Array.isArray(raw.baselineProducts)?raw.baselineProducts.slice(0,1000):[],
    baselineAt:Number(raw.baselineAt)||0,
    lastCheckedAt:Number(raw.lastCheckedAt)||0,
    lastMatchedAt:Number(raw.lastMatchedAt)||0
  };
}

function trimAlertedState(state){
  return Object.fromEntries(Object.entries(state).sort((a,b)=>Number(b[1]?.alertedAt||0)-Number(a[1]?.alertedAt||0)).slice(0,500));
}
