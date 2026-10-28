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
    fs.writeFileSync(r('./dist/manifest.json'), JSON.stringify(m, null, 2));
  },
});

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react(), tailwindcss(), manifest()],
  resolve: { alias: { '@': r('./src/page') } },
  build: {
    outDir: '../dist', emptyOutDir: true, target: 'chrome140', modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: r('./src/sidepanel.html'),
        newtab: r('./src/newtab.html'),
        page: r('./src/page.html'),
        sw: r('./src/sw/index.js'),
      },
      output: { entryFileNames: (c) => (c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
