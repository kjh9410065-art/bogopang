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
const CACHE_URL = "https://bogopang.tcflick.com/api/products";

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
  // Gold Box 실패가 전체 상품 수집 실패로 이어지지 않도록 독립적으로 처리합니다.
  let goldboxProducts = [];
  try {
    const goldbox = await coupangRequest("GET", GOLD_BOX_PATH, env);
    goldboxProducts = Array.isArray(goldbox.data)
      ? goldbox.data
      : Array.isArray(goldbox.data?.productData)
        ? goldbox.data.productData
        : [];
    console.log("보고팡 Gold Box 상품 수:", goldboxProducts.length);
  } catch (error) {
    console.error("보고팡 Gold Box 조회 실패:", error.message);
  }

  // 외부 트렌드에서 상품과 연결하기 좋은 후보를 먼저 선정합니다.
  const trendSignals = await loadTrendSignals(env);

  // 트렌드 상품은 최대 8개 키워드를 먼저 검색하고,
  // 결과가 부족할 때만 남은 적합 키워드를 추가로 사용합니다.
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

  const searchSignals = trendSignals.slice(0, TREND_KEYWORD_CANDIDATE_LIMIT);

  for (const signal of searchSignals) {
    if (usedSignals.length >= TREND_KEYWORD_LIMIT || countUniqueProducts() >= MIN_TRENDING_PRODUCTS) {
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
      usedSignals.push(signal);

      trendingRaw.push(
        ...products.map((item) => ({
          ...item,
          trendKeyword: signal.keyword,
          trendKeywords: [signal.keyword],
          trendSource: signal.source
        }))
      );
    } catch (error) {
      console.error("보고팡 트렌드 상품 조회 실패:", signal.keyword, error.message);
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

  const converted = [];

  for (let i = 0; i < allRaw.length; i += 50) {
    const batch = allRaw.slice(i, i + 50);
    const urls = batch
      .map((item) =>
        item.productId
          ? `https://www.coupang.com/vp/products/${item.productId}`
          : item.productUrl
      )
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

      // 배치 변환이 실패해도 개별 변환을 재시도해 전체 상품이 사라지지 않게 합니다.
      for (const originalUrl of urls) {
        try {
          const single = await coupangRequest(
            "POST",
            DEEPLINK_PATH,
            env,
            { coupangUrls: [originalUrl] }
          );

          for (const link of single.data || []) {
            const partnerUrl = link.shortenUrl || link.landingUrl;
            if (partnerUrl) converted.push([link.originalUrl, partnerUrl]);
          }
        } catch (singleError) {
          console.error("보고팡 개별 딥링크 변환 실패:", originalUrl, singleError.message);
        }
      }
    }
  }

  const linkMap = new Map(converted);

  // 쿠팡 원본 데이터를 보고팡 공통 상품 구조로 변환합니다.
  const toSiteProduct = (item, source) => {
    const canonicalUrl = item.productId
      ? `https://www.coupang.com/vp/products/${item.productId}`
      : item.productUrl;
    const partnerUrl = linkMap.get(canonicalUrl) || linkMap.get(item.productUrl);

    // 필수 표시 정보와 정상적인 제휴 링크가 없는 상품은 최종 데이터에서 제외합니다.
    if (
      !partnerUrl ||
      !item.productId && !item.productUrl ||
      !item.productName ||
      item.productPrice == null ||
      !item.productImage
    ) {
      return null;
    }

    const trendKeywords = Array.isArray(item.trendKeywords)
      ? [...new Set(item.trendKeywords.filter(Boolean))]
      : item.trendKeyword
        ? [item.trendKeyword]
        : [];

    return {
      id: String(item.productId || item.productUrl || item.productName),
      name: item.productName,
      price: item.productPrice,
      originalPrice:
        item.originalPrice ??
        item.productOriginalPrice ??
        item.listPrice ??
        null,
      discountRate:
        item.discountRate ??
        item.discountRatePercent ??
        null,
      image: item.productImage,
      category: item.categoryName || "기타",
      rocket: Boolean(item.isRocket),
      keyword: trendKeywords[0] || null,
      trendKeywords,
      trendSource: item.trendSource || null,
      source,
      url: partnerUrl
    };
  };

  const specialDeals = uniqueById(goldboxProducts)
    .map((item) => toSiteProduct(item, "오늘의 특가"))
    .filter(Boolean);

  const trendingSearch = uniqueById(trendingRaw)
    .map((item) => toSiteProduct(item, "오늘의 관심 키워드"))
    .filter(Boolean);

  const rocketProducts = rocketRaw
    .map((item) => toSiteProduct(item, "로켓배송"))
    .filter(Boolean);

  const products = [...specialDeals, ...trendingSearch, ...rocketProducts];

  console.log("보고팡 최종 상품 수:", {
    goldbox: goldboxProducts.length,
    trending: trendingRaw.length,
    rocket: rocketRaw.length,
    affiliate: products.length
  });

  if (!products.length) {
    throw new Error("쿠팡 API에서 사용할 수 있는 상품이 0개입니다.");
  }

  return {
    specialDeals,
    trendingSearch,
    popularProducts: [],
    rocketProducts,

    // 실제로 검색에 사용한 외부 트렌드 키워드와 출처만 저장합니다.
    trendKeywords: usedSignals.map((signal) => ({
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

      // 카테고리 단서가 없는 일반 검색어는 짧은 상품명 후보만 허용합니다.
      const wordCount = normalized.split(/\s+/).filter(Boolean).length;
      const looksLikeSentence =
        /[?!]|검색량|급상승|순위|발표|논란|왜|어떻게|언제|누가|무슨|관련/.test(normalized);

      return wordCount <= 3 && !looksLikeSentence;
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
  return ["specialDeals", "trendingSearch", "rocketProducts"]
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
    console.log("보고팡 상품 갱신 완료:", new Date().toISOString());
    return {
      productCount:
        products.specialDeals.length +
        products.trendingSearch.length +
        products.rocketProducts.length
    };
  } catch (error) {
    console.error("보고팡 상품 갱신 실패:", error);
    throw error;
  }
}
