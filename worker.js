// 보고팡 Cloudflare Worker입니다.
// 정적 사이트를 제공하고 이후 쿠팡 파트너스 API와 일일 갱신을 연결합니다.
export default {
  async fetch(request, env) {
    // 기본 요청은 public 폴더의 정적 사이트를 반환합니다.
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    // 매일 한국시간 오전 7시(UTC 22시)에 실행되는 갱신 자리입니다.
    console.log("보고팡 일일 갱신 실행:", new Date().toISOString());
  }
};