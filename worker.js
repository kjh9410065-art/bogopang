// 보고팡 Cloudflare Worker입니다.
// 쿠팡 파트너스 API를 서버에서 호출해 API 키를 브라우저에 노출하지 않습니다.

const COUPANG_DOMAIN = "https://api-gateway.coupang.com";
const GOLD_BOX_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/goldbox?limit=8&imageSize=300x300";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
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

    // 상품 API 요청은 쿠팡 Gold Box 데이터를 가져와 24시간 캐시합니다.
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

// 오늘의 Gold Box 상품을 가져오고 파트너스 링크를 생성합니다.
async function loadProducts(env) {
  // 쿠팡 공식 Gold Box 상품 API를 호출합니다.
  const goldbox = await coupangRequest("GET", GOLD_BOX_PATH, env);

  // Gold Box 응답 상품 배열을 안전하게 꺼냅니다.
  const products = Array.isArray(goldbox.data)
    ? goldbox.data
    : Array.isArray(goldbox.data?.productData)
      ? goldbox.data.productData
      : [];

  // 화면에 표시할 상품 수를 8개로 제한합니다.
  const selected = products.slice(0, 8);
  const converted = [];

  // Gold Box에서 받은 URL 대신 상품 ID로 표준 상품 URL을 만들어 변환합니다.
  // 일부 Gold Box URL은 Deeplink API에서 "url convert failed"가 발생할 수 있기 때문입니다.
  for (const item of selected) {
    const originalUrl = item.productUrl;
    const canonicalUrl = item.productId
      ? `https://www.coupang.com/vp/products/${item.productId}`
      : originalUrl;

    if (!canonicalUrl) continue;

    try {
      // 상품 하나씩 변환하여 특정 상품 하나의 오류가 전체 갱신을 막지 않게 합니다.
      const deeplink = await coupangRequest(
        "POST",
        DEEPLINK_PATH,
        env,
        { coupangUrls: [canonicalUrl] }
      );

      const link = (deeplink.data || [])[0];
      const partnerUrl = link?.shortenUrl || link?.landingUrl;

      if (partnerUrl) {
        converted.push({
          item,
          originalUrl,
          partnerUrl
        });
      }
    } catch (error) {
      // 변환할 수 없는 상품은 건너뛰고 다음 상품을 계속 처리합니다.
      console.error("보고팡 딥링크 변환 실패:", canonicalUrl, error.message);
    }
  }

  // 파트너스 링크가 정상적으로 생성된 상품만 사이트에 표시합니다.
  return converted.map(({ item, partnerUrl }) => ({
    name: item.productName,
    price: item.productPrice,
    image: item.productImage,
    category: item.categoryName || "기타",
    rocket: Boolean(item.isRocket),
    url: partnerUrl
  }));
}

// 상품 데이터를 24시간 캐시해 불필요한 API 호출을 줄입니다.
async function getProductsResponse(env, ctx) {
  const request = new Request(CACHE_URL, { method: "GET" });
  const cache = caches.default;

  // 먼저 기존 상품 데이터를 확인합니다.
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  // 캐시가 없으면 쿠팡에서 새 상품을 가져옵니다.
  try {
    const products = await loadProducts(env);
    const response = new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "public, max-age=86400"
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
        "Cache-Control": "public, max-age=86400"
      }
    });

    // 기존 캐시를 오늘의 상품 데이터로 덮어씁니다.
    await cache.put(request, response);
    console.log("보고팡 상품 일일 갱신 완료:", new Date().toISOString());
  } catch (error) {
    console.error("보고팡 일일 갱신 실패:", error);
  }
}
