# D — A2A Browser를 Chromium 위에 직접 빌드하기

## 왜
Electron은 "앱 속 브라우저"라서 구글이 OAuth 로그인을 정책적으로 막는다(2021-09~). 이름표를 고쳐도 다른 신호로 다시 막을 수 있고,
맥 패스키(아이클라우드 키체인)는 그 도메인이 앱을 직접 허락해야 해서 구글 로그인에는 못 쓴다. Brave·Vivaldi·Arc처럼 **Chromium 자체를
우리 이름으로 빌드**하면 "진짜 브라우저"로 돌아 구글 로그인·패스키(휴대폰 QR)·확장 프로그램이 정상 동작한다.

## 이 맥 (2026-10-28 확인)
- 디스크 여유 251GB(필요 ~100GB) · M2 Pro 10코어 · **메모리 16GB(최소선 — 빌드가 느림, 병렬도를 낮춰야 할 수 있음)**
- **정식 Xcode 없음** → App Store에서 설치 필요(애플 계정, ~15GB). 설치 후 `sudo xcode-select -s /Applications/Xcode.app` 와 라이선스 동의.
- 작업 폴더: `~/a2a-chromium` (`depot_tools/`, `src/`) — 세션 폴더가 아니라 홈에 둔다(지워지지 않게).

## 단계
1. **원본 빌드** — 소스 받기(`fetch --nohooks --no-history chromium`) → `gclient runhooks` → `gn gen out/A2A` → `autoninja -C out/A2A chrome`.
   확인: 우리 빌드에서 MYSCube 구글 로그인 · 휴대폰 QR 패스키.
2. **브랜딩** — 이름 "A2A Browser", 아이콘, 번들 ID(`chrome/app/theme/chromium/BRANDING`·아이콘 자산). 새 탭/첫 실행 화면.
3. **우리 기능 넣기** — 지금 Electron 셸의 React 화면(사이드 패널: AI 채팅·팀 채널, 새 탭: "무엇을 맡길까요?")과 에이전트를
   **내장 확장(component extension)**으로 싣는다. 페이지 도구는 `chrome.scripting`/`chrome.debugger`, 화면은 `chrome.sidePanel`·새 탭 대체.
   승인 게이트·데이터 경계·비밀번호 원칙은 그대로 옮긴다.
4. **깊은 변경(C++)** — 세로 탭·배경화면·카드 레이아웃처럼 확장으로 안 되는 브라우저 UI.
5. **배포** — 코드 서명·공증, 자동 업데이트(Sparkle 등), 애플에 브라우저용 패스키 권한 신청(아이클라우드 키체인).
6. **유지** — Chromium은 4주마다 새 버전(보안 수정 포함). 우리 패치는 작게 유지하고 리베이스를 정기 작업으로 둔다.

## 지금 상태 (2026-11-07)
- 1단계 원본 빌드: 됨 — `~/dev/chromium/src/out/A2A/Chromium.app` (Chromium 159). Xcode 26은 Metal 툴체인을 따로 받아야 한다:
  `sudo xcodebuild -runFirstLaunch && xcodebuild -downloadComponent MetalToolchain`.
- 3단계 내장 확장: 됨 — `chromium/patches/0001-a2a-builtin-extension.patch`가 `browser-ext`를 앱 번들 `Resources/a2a`에
  싣고 `ComponentLoader`가 시작할 때 내장 확장으로 올린다(확장 목록에 안 보이고, 권한 창 없음, `--load-extension` 필요 없음).
  빌드: `./chromium/build.sh` (패치 확인 → 확장 빌드·복사 → autoninja).
- 업무 기록·업무 지도(온톨로지)·하네스 개선·업무 유형·SSoT·팀 채팅 기록도 들어갔다. `browser/`의 모듈(events.js·ontology.js·
  harness.js·worktypes.js·recall.js·ssot.js)을 **복사하지 않고 그대로** 번들한다 — Node API만 `browser-ext/src/shim/`
  (fs → IndexedDB, crypto → sha256)로 바꾼다. 규칙은 browser/ 한 곳에만 있다.
- 4단계 C++ 브라우저 UI: 시작 — `chromium/patches/0002-a2a-browser-ui.patch`
  - 세로 탭이 기본(`tab_strip_prefs.cc`의 `kVerticalTabsEnabled` 기본값 true). 사용자가 끄면 그 선택을 따른다.
  - A2A 버튼은 툴바에 늘 고정(`toolbar_actions_model.cc` — 정책 강제 고정과 같은 자리). 퍼즐 메뉴에서 꺼낼 필요 없음.
  - 카드 레이아웃: 탭이 하나여도 웹 페이지가 브라우저 배경 위에 8px 띄운 둥근 카드(분할 보기와 같은 6px 모서리).
    기능 `kA2ACardContents`(`ui_features`, 기본 켜짐) — `--disable-features=A2ACardContents`로 끈다.
  - 확인(2026-11-07, 새 프로필): UI DevTools(`--enable-ui-devtools`)로 본 뷰 트리에서
    `VerticalTabStripRegionView` 240px·가로 탭 줄 0×0, `ContentsContainerView` insets 8·`ContentsWebView` 모서리 6,
    확장에서 `chrome.action.getUserSettings()` → `isOnToolbar: true`. 시험 31/31(내장 모드, `A2A_BUILTIN=1`).
- 메리 딜룸·학습 모드·EMA Station·객관식(업무 유형)·업무 기록 올리기·`a2a://` 주소(패치 0004)·즐겨찾기도 들어갔다. 새 탭은 홈 화면, 에이전트 패널은 창과 함께 열린다(패치 0003).
- 확인(2026-11-09, 내장 모드): 시험 45/45. 메리는 실제 키로 딜 만들기·텍스트 첨부·근거 추출·질문까지 확인했다. EMA 실제 로그인과 학습의 실제 모델 호출은 아직 확인하지 못했다.
- 한계: EMA 로그인은 브라우저를 켤 때마다 다시 한다(토큰을 디스크에 평문으로 두지 않는다). 학습의 "내 코드와 연결"은 실제 파일 시스템이 없어 꺼져 있다(과정 만들기·튜터·복습은 동작). 자료 파일은 프로필의 IndexedDB에 저장되고 서비스 워커가 메모리에 올린다.
- 옮기지 않는 것: 바깥 어댑터 HTTP 입구(collect-router.js — MV3는 포트를 열 수 없고, 등록된 어댑터도 아직 없다). Electron 왼쪽 사이드바는 Chromium 세로 탭 + 에이전트 패널이 대신한다.
- 아직: 4단계의 나머지(배경화면·확장으로 안 되는 화면).

## 개발용 빌드 설정(`out/A2A/args.gn`, 처음)
```
is_debug = false
is_component_build = true      # 링크가 빨라 개발용
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
target_cpu = "arm64"
enable_nacl = false
chrome_pdf_symbol_level = 0
```
Google API 키는 넣지 않는다(크롬 동기화 같은 구글 서비스용 — 웹사이트 구글 로그인과는 무관). 시작 시 "API 키 없음" 안내가 뜰 수 있다.

## 지금 Electron 앱과의 관계
Electron 앱(`A2A/browser`)은 기능·화면 실험장으로 계속 쓴다. 검증된 기능부터 3단계에서 Chromium 내장 확장으로 옮긴다.
