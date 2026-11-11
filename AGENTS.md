# AGENTS.md

이 저장소에서 일하는 AI 에이전트(Codex, Claude Code 등)를 위한 안내.

## 설치를 부탁받았다면

"A2A 설치해줘", "처음부터 세팅", "브라우저 빌드해줘" 같은 요청이면
[`.claude/skills/install-a2a/SKILL.md`](.claude/skills/install-a2a/SKILL.md)를 처음부터 끝까지 읽고 그대로 따른다.
Claude Code에서는 같은 문서가 `install-a2a` 스킬로 잡힌다.
설치가 끝나면 같은 폴더의 [`features.md`](.claude/skills/install-a2a/features.md)로 기능을 하나씩 써 보고 결과를 보고한다 — 무슨 기능이 있고 어떻게 이어지는지도 거기 있다.

지킬 것:
- API 키·암호는 사람이 직접 넣는다. 대화에 붙여 넣게 하지 말고, 값을 읽거나 출력하지 않는다.
- `sudo`가 필요한 명령과 시스템·보안 설정 변경은 실행하지 말고 사람에게 정확한 명령을 준다.
- Chromium은 `chromium/REVISION`의 고정 버전으로 받는다. 최신 main을 받지 않는다.
