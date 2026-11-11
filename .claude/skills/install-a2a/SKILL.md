---
name: install-a2a
description: 새 맥에서 A2A 브라우저(Chromium + 우리 패치 + 내장 확장)와 로컬 엔진을 처음부터 설치하고 띄운다. "A2A 설치해줘", "A2A 브라우저 깔아줘", "이 저장소 처음부터 세팅", "install A2A" 요청에 사용. 이미 설치된 맥에서 다시 빌드·재실행할 때도 쓴다.
---

# A2A 설치 — 새 맥에서 처음부터

이 문서는 사람이 아니라 **설치를 맡은 AI 에이전트**(Claude Code, Codex 등)가 읽고 그대로 따라 하는 절차다.
명령은 직접 실행한다. 사람에게 넘기는 것은 아래 "사람이 해야 하는 것" 세 가지뿐이다.

끝나면 이렇게 된다:
- `~/dev/chromium/src/out/A2A/Chromium.app` — A2A 브라우저(세로 탭, 옆 패널 에이전트, 메리, 업무 지도·온톨로지, 접점 찾기, 해상 운임, 학습이 들어 있음)
- 엔진 `http://127.0.0.1:8423` — 브라우저가 여기에 붙는다(주소는 `browser-ext/src/sw/config.js`에 고정)

## 사람이 해야 하는 것 (대신 하지 말 것)

1. **Xcode 설치** — App Store에서 전체 Xcode(명령줄 도구만으로는 Chromium이 빌드되지 않는다). 설치 후 라이선스 동의는 관리자 암호가 필요하다: `sudo xcodebuild -license accept`
2. **GitHub** — 저장소는 공개라 받기만 하면 권한은 필요 없다. 고친 것을 올리려면 GitHub 로그인·권한은 사람이 한다.
3. **Anthropic API 키** — 키를 대화에 붙여 넣게 하지 말 것. 사람이 **자기 터미널에서** `./setup-mac.sh`를 실행해 숨김 입력으로 넣게 하거나, `.env`의 `ANTHROPIC_API_KEY=` 줄을 직접 채우게 한다. 에이전트는 키 값을 읽거나 출력하지 않는다(`grep -c '^ANTHROPIC_API_KEY=.\+' .env`처럼 있는지만 확인).

sudo가 필요한 명령, 시스템·보안 설정 변경은 실행하지 말고 사람에게 정확한 명령을 주고 기다린다.

## 0. 확인

```bash
uname -m                      # arm64 여야 함 (args.gn이 arm64 기준)
xcodebuild -version           # 전체 Xcode — "requires Xcode"가 나오면 사람 1번
df -h ~                       # 여유 100GB 이상 (Chromium 소스 ~40GB + 빌드 결과)
command -v brew || echo "Homebrew 없음"
```

Homebrew가 없으면 https://brew.sh 의 설치 한 줄을 사람에게 실행하게 한다(관리자 암호를 묻는다).

## 1. 저장소

```bash
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/merryAI-dev/A2A.git
cd A2A
```

이미 있으면 받은 브랜치가 맞는지만 본다. 이 문서는 저장소 안에 있으므로, 이후 경로는 저장소 루트(`~/dev/A2A`) 기준이다.

## 2. 엔진 (Python · Postgres · Redis · osquery)

```bash
./setup-mac.sh --check        # 무엇을 할지 미리 보기(아무것도 바꾸지 않음)
```

본 실행은 이름과 API 키를 터미널에서 묻는다. **사람이 자기 터미널에서** 돌리게 한다:

```bash
./setup-mac.sh
```

- 이름: 영문 소문자. 업무 기록·팀 채팅에 쓰인다.
- 키: 숨김 입력. 엔터를 누르면 나중에 `.env`에 넣을 수 있다.
- 하는 일: brew로 postgresql@17·redis·node@22·uv 설치와 상시 실행, 로컬 DB 생성, `.venv`, `.env`(있는 값은 덮어쓰지 않음), 팀 채팅 시드, `browser/`·`browser-ext/` npm 설치, osquery를 `data/osquery/`에 받기(SHA-256·서명 확인, 시스템 설치 없음).
- 다시 돌려도 안전하다.

사람이 돌릴 수 없는 상황이면 에이전트가 `./setup-mac.sh </dev/null`로 돌려도 된다 — 이름은 맥 사용자 이름, 키는 빈 값으로 들어가고, 키는 나중에 사람이 `.env`에 넣는다.

## 3. Chromium 소스 (고정 버전)

우리 패치(`chromium/patches/`)는 `chromium/REVISION`의 커밋에 맞춰 만들었다. **최신 main을 받지 말 것** — 패치가 안 맞아 빌드가 멈춘다.

```bash
REV="$(head -1 ~/dev/A2A/chromium/REVISION)"
[[ -d ~/dev/depot_tools ]] || git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ~/dev/depot_tools
export PATH="$HOME/dev/depot_tools:$PATH"
mkdir -p ~/dev/chromium && cd ~/dev/chromium
# fetch 대신 gclient를 직접 — fetch는 최신 main을 받은 뒤 다시 고정 버전으로 받아 두 번 받게 된다
gclient config --name src --unmanaged https://chromium.googlesource.com/chromium/src.git
caffeinate -dims gclient sync --nohooks --no-history --revision "src@$REV"   # 수십 GB, 1시간 안팎
caffeinate -dims gclient runhooks
git -C src rev-parse HEAD                                   # = $REV 인지 확인
```

- 오래 걸리는 명령은 백그라운드로 돌리고 끝날 때까지 기다린다. 중간에 끊기면 같은 `gclient sync` 명령을 다시 돌리면 이어진다.
- `git -C src rev-parse HEAD`가 `$REV`와 다르면 `cd src && git fetch --depth=1 origin "$REV" && git checkout --detach FETCH_HEAD && cd .. && gclient sync --nohooks --no-history --revision "src@$REV"`로 맞춘다.
- 다른 경로에 받았으면 이후 `CHROMIUM_SRC=<그 경로>/src`를 붙인다.

## 4. A2A 브라우저 빌드

```bash
cd ~/dev/A2A
A2A_JOBS=8 ./chromium/build.sh
```

`build.sh`가 하는 일: 고정 버전 확인 → 패치 적용(이미 있으면 건너뜀) → `browser-ext` 빌드(필요하면 npm 설치) → 내장 확장·틀 색을 Chromium 소스에 복사 → `out/A2A/args.gn`이 없으면 `chromium/args.gn` 복사 → `autoninja`.

- **첫 빌드는 몇 시간** 걸린다. 백그라운드로 돌리고 기다린다. 다음부터는 바뀐 부분만이라 몇 분이다.
- `A2A_JOBS`는 코어 수 정도. 메모리가 16GB 이하면 4~6으로 낮춘다.
- 패치 적용에서 멈추면: 3단계의 `git rev-parse HEAD`가 `REVISION`과 같은지부터 본다.
- **A2A 브라우저가 열려 있으면 먼저 닫고 빌드한다.** 열린 채로 빌드하면 macOS가 옛 실행 파일을 붙잡아 다음 실행이 `Library not loaded: libchrome_dll.dylib`로 실패한다.

## 5. 실행

```bash
cd ~/dev/A2A
./run-mac.sh --backend &          # 엔진 :8423 + 워커. 로그 data/logs/engine.log
curl -fsS http://127.0.0.1:8423/healthz && echo 엔진-OK
open ~/dev/chromium/src/out/A2A/Chromium.app
```

`./run-mac.sh`(인자 없이)는 예전 Electron 앱을 띄운다 — A2A 브라우저에는 `--backend`만 쓴다.

브라우저는 개발용 계정 `boram`으로 시작한다(옆 패널 위쪽 워크스페이스 단추로 alice·bob·carol·acme_ceo로 바꿀 수 있다). setup이 이 계정들을 엔진 허용 목록(`.env`의 `SAAS_ALLOWED_USERS`)과 팀 채팅 워크스페이스 TEST에 넣는다. 403이 나면 그 이름이 목록에 있는지 보고, 넣은 뒤 엔진을 다시 띄운다.

AI 기능(에이전트·메리)은 엔진이 `.env`의 키로 모델을 부른다(`A2A_DEV_LLM_PROXY=1`, setup이 넣음). 키를 브라우저에 넣을 필요는 없다.

## 6. 됐는지 확인

```bash
cd ~/dev/A2A/browser-ext
A2A_CHROMIUM=~/dev/chromium/src/out/A2A/Chromium.app/Contents/MacOS/Chromium npm test
```

- 전부 통과해야 끝이다. 실제 모델을 부르는 시험(`-real`)은 API 키가 있어야 통과한다 — 키가 없으면 그 시험들만 실패하는 것이 정상이니, 그렇게 보고한다.
- 드물게 실제 모델 시험 도중 브라우저가 응답을 멈추고 뒤 시험이 모두 `CDP 시간 초과`로 실패한다. 테스트 프로세스와 그 브라우저를 끄고 다시 돌린다(같은 실패가 반복되면 그대로 보고).
- 엔진 시험: `.venv/bin/python -m pytest tests/ -q` — 일부 기존 실패가 있다. 새로 생긴 실패인지는 같은 커밋의 다른 맥 결과와 비교해야 알 수 있으니, 숫자만 보고 단정하지 말 것.

사람에게는 이렇게 보고한다: 설치한 것, 걸린 시간, 시험 결과(통과·실패 수와 실패 이름), 사람이 아직 해야 할 것(키 등).

## 다시 빌드·재실행 (설치된 맥)

```bash
cd ~/dev/A2A && git pull
osascript -e 'quit app "Chromium"' 2>/dev/null        # 열린 A2A 브라우저를 먼저 닫는다
./chromium/build.sh
pkill -f "uvicorn app.main:app" ; ./run-mac.sh --backend &
open ~/dev/chromium/src/out/A2A/Chromium.app
```

엔진 코드(`app/`)가 바뀌었으면 엔진을 다시 띄워야 새 경로가 생긴다.

## 알아 둘 것

- **이 맥 안에서만**: 엔진은 개발용 인증(`SAAS_AUTH=dev`)이라 127.0.0.1에만 연다. 바깥에 열지 말 것.
- **기록은 이 맥에만**: 메리 검토·업무 지도·대화 기록은 브라우저 프로필에 쌓이고, 다른 맥과 공유되지 않는다.
- **빌드는 옮길 수 없다**: `args.gn`이 개발용(component build)이라 `Chromium.app`만 복사하면 다른 맥에서 뜨지 않는다. 다른 맥은 이 절차를 처음부터 따른다.
- **Chromium 버전을 올릴 때**: `chromium/REVISION`을 바꾸고 패치를 다시 맞춘 뒤 함께 커밋한다. 둘이 어긋나면 새로 설치하는 사람의 빌드가 깨진다.
