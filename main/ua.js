// main/ua.js
// 구글은 "안전하지 않은 브라우저"라며 임베디드 브라우저의 로그인을 막는다.
// UA 문자열만 고쳐서는 안 통한다 — Chromium 이 같이 보내는 Client Hints
// (Sec-CH-UA 브랜드 목록)에 "Electron" 이 그대로 남기 때문이다. 둘 다 맞춘다.
const { app, session } = require('electron');

// "Mozilla/5.0 ... Chrome/144.0.0.0 Electron/44.0.0 browse/1.0.0 Safari/537.36"
// 에서 Electron/앱 토큰만 뗀다. 나머지는 손대지 않는다 — 크롬이 실제로 보내는
// 문자열에서 멀어질수록 오히려 더 잘 걸린다.
function chromeUa(ua, appName) {
  const appTag = appName ? appName + '/' : null;
  return String(ua || '')
    .split(' ')
    .filter((t) => !t.startsWith('Electron/') && !(appTag && t.startsWith(appTag)))
    .join(' ');
}

function chromeMajor(ua) {
  const m = /Chrome\/(\d+)/.exec(String(ua || ''));
  return m ? m[1] : '';
}

// Sec-CH-UA 브랜드 목록. 크롬이 보내는 모양 그대로 (GREASE 항목 포함).
function brandList(major) {
  return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not=A?Brand";v="24"`;
}

// 헤더 이름은 대소문자가 섞여 들어온다. 이름을 모르는 채로 지우거나 바꾼다.
function rewriteHints(headers, brands) {
  for (const name of Object.keys(headers)) {
    const k = name.toLowerCase();
    if (k === 'sec-ch-ua') headers[name] = brands;
    // 전체 버전 목록에는 "Electron";v="44.0.0" 이 통째로 들어 있다. 브랜드만
    // 맞춰 봐야 소용없으니 아예 뺀다 — 안 보내는 건 정상이다(선택적 힌트).
    else if (k === 'sec-ch-ua-full-version-list' || k === 'sec-ch-ua-full-version') delete headers[name];
  }
  return headers;
}

// 이 세션에서 나가는 모든 요청을 크롬처럼 보이게 한다.
// 세션 전체에 거는 이유: 페이지가 만드는 하위 요청(iframe, fetch)까지 같은
// 정체성이어야 한다. 탭마다 setUserAgent 를 부르면 그것들이 어긋난다.
function applyChromeIdentity(ses = session.defaultSession) {
  const ua = chromeUa(app.userAgentFallback, app.getName());
  app.userAgentFallback = ua; // 이후 만들어지는 webContents 의 기본값
  const brands = brandList(chromeMajor(ua));
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = details.requestHeaders;
    headers['User-Agent'] = ua;
    cb({ requestHeaders: rewriteHints(headers, brands) });
  });
  return ua;
}

module.exports = { applyChromeIdentity, chromeUa, chromeMajor, brandList, rewriteHints };
