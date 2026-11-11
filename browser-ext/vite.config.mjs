// A2A 확장 빌드 — src/ → dist/ (Chromium에 그대로 싣는 폴더)
//   sidepanel.html : AI 채팅·팀 채널(사이드 패널)
//   newtab.html    : 새 탭 "무엇을 맡길까요?"
//   page.html      : 에이전트 결과 페이지
//   sw.js          : 서비스 워커(상태·에이전트·팀 채팅 다리)
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// manifest.json을 dist에 — 공개 키를 넣어 확장 ID를 고정한다(내장 확장으로 옮길 때도 같은 ID)
const manifest = () => ({
  name: 'a2a-manifest',
  writeBundle() {
    const m = JSON.parse(fs.readFileSync(r('./manifest.base.json'), 'utf8'));
    m.key = fs.readFileSync(r('./public-key.txt'), 'utf8').trim();
    // 버전이 그대로면 Chromium은 프로필에 저장된 옛 서비스 워커를 계속 돌린다 — 빌드마다 올린다
    const now = new Date();
    const days = Math.floor((now - Date.UTC(2026, 0, 1)) / 86400000);
    m.version = `${m.version}.${days}${String(Math.floor((now % 86400000) / 2000)).padStart(5, '0')}`.replace(/^(\d+\.\d+)\.\d+\.(\d+)(\d{5})$/, '$1.$2.$3');
    fs.writeFileSync(r('./dist/manifest.json'), JSON.stringify(m, null, 2));
  },
});

export default defineConfig({
  root: 'src',
  server: { fs: { allow: ['..', '../../browser'] } },
  base: './',
  plugins: [react(), tailwindcss(), manifest()],
  // browser/(Electron 앱)의 업무 기록·온톨로지·하네스 모듈을 복사하지 않고 그대로 싣는다 — Node API만 shim으로 바꾼다
  resolve: {
    alias: [
      { find: '@', replacement: r('./src/page') },
      { find: /^(node:)?fs$/, replacement: r('./src/shim/fs.js') },
      { find: /^(node:)?crypto$/, replacement: r('./src/shim/crypto.js') },
      { find: /^(node:)?path$/, replacement: r('./node_modules/path-browserify/index.js') },
      { find: /^@anthropic-ai\/sdk$/, replacement: r('./src/shim/anthropic.js') },
      { find: /^electron$/, replacement: r('./src/shim/electron.js') },
      { find: /^(node:)?http$/, replacement: r('./src/shim/http.js') },
      // browser/ema-mcp.js가 부르는 SDK — ESM 빌드를 이 폴더의 node_modules에서
      { find: /^@modelcontextprotocol\/sdk\/(.*)$/, replacement: r('./node_modules/@modelcontextprotocol/sdk/dist/esm/$1') },
      // browser/ 화면(업무 지도)이 쓰는 라이브러리는 이 폴더의 node_modules에서
      { find: /^(react|react-dom|d3-force)(\/.*)?$/, replacement: r('./node_modules/$1$2') },
    ],
  },
  define: { __dirname: JSON.stringify('/a2a/browser'), 'process.env': '{}', 'process.pid': '1' },
  build: {
    outDir: '../dist', emptyOutDir: true, target: 'chrome140', modulePreload: false,
    commonjsOptions: { include: [/browser\/[^/]+\.js$/, /browser\/invest\//, /browser\/learn\//, /node_modules/], requireReturnsDefault: 'preferred', transformMixedEsModules: true },
    rollupOptions: {
      input: {
        sidepanel: r('./src/sidepanel.html'),
        newtab: r('./src/newtab.html'),
        page: r('./src/page.html'),
        map: r('./src/map.html'),
        merry: r('./src/merry.html'),
        contacts: r('./src/contacts.html'),
        freight: r('./src/freight.html'),
        learn: r('./src/learn.html'),
        sw: r('./src/sw/index.js'),
      },
      output: { entryFileNames: (c) => (c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
