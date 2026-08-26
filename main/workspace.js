// main/workspace.js
// 에이전트 전용 작업 디렉터리를 관리한다. electron 을 require 하지 않는다 —
// 파일을 지우는 코드라 순수 node 로 테스트할 수 있어야 한다.
const fs = require('node:fs');
const path = require('node:path');

// 디렉터리 안을 비운다. 디렉터리 자체는 남긴다.
// 안전장치: 지울 대상은 반드시 expectedParent 바로 아래의 expectedName 이어야 한다.
// 경로가 그 모양이 아니면 아무것도 지우지 않고 그 사실을 알린다 — 잘못된 경로가
// 흘러들어왔을 때 조용히 남의 디렉터리를 비우는 것보다 안 지우는 쪽이 낫다.
// 심볼릭 링크는 rmSync 가 lstat 으로 판단해 링크만 지운다. 대상까지 따라가지 않는다.
function clearDir(dir, expectedParent, expectedName) {
  if (path.resolve(path.dirname(dir)) !== path.resolve(expectedParent) || path.basename(dir) !== expectedName) {
    return [`경로가 예상과 달라서 비우지 않았다: ${dir}`];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // 아직 없는 건 이미 비어 있는 것과 같다
  }
  const failed = [];
  for (const name of entries) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }
  return failed;
}

module.exports = { clearDir };
