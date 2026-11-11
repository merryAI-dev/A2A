// 글을 끌어 고르면 그 위에 뜨는 작은 메뉴 — 복사 · 검색 · 옆에서 검색(분할 뷰). 우리 화면(앱 페이지·사이드 패널) 어디서나 같다.
// 입력 칸·문서 편집기 안의 선택에는 뜨지 않는다(거기는 자기 도구가 있다).
import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

const editable = (node) => {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
};

function picked() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text || !sel.rangeCount || editable(sel.anchorNode)) return null;
  const rects = sel.getRangeAt(0).getClientRects();
  const r = rects[rects.length - 1];
  return r ? { text, x: r.right, y: r.bottom } : null;
}

export default function SelectionMenu() {
  const [at, setAt] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const show = (e) => { if (!e.target.closest?.('#selection-menu')) setTimeout(() => { setCopied(false); setAt(picked()); }, 0); };
    const hide = () => { if (!window.getSelection()?.toString().trim()) setAt(null); };
    const gone = () => setAt(null);
    document.addEventListener('mouseup', show);
    document.addEventListener('keyup', show);
    document.addEventListener('selectionchange', hide);
    document.addEventListener('scroll', gone, true);
    return () => {
      document.removeEventListener('mouseup', show);
      document.removeEventListener('keyup', show);
      document.removeEventListener('selectionchange', hide);
      document.removeEventListener('scroll', gone, true);
    };
  }, []);
  if (!at) return null;
  const copy = async () => { await navigator.clipboard.writeText(at.text); setCopied(true); setTimeout(() => setAt(null), 700); };
  const search = () => { window.a2a.send('search:text', at.text); setAt(null); };
  const beside = () => { window.a2a.send('search:split', at.text); setAt(null); };
  const left = Math.max(8, Math.min(at.x - 60, window.innerWidth - 250));
  const top = at.y + 34 > window.innerHeight ? at.y - 62 : at.y + 6;
  const item = 'flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium hover:bg-raise';
  return (
    <div id="selection-menu" onMouseDown={(e) => e.preventDefault()} style={{ left, top }}
         className="no-print fixed z-[1000] flex items-center gap-0.5 rounded-lg bg-field p-0.5 text-card-ink shadow-lg ring-1 ring-card-line select-none">
      <button id="selection-copy" onClick={copy} className={item}><Icon name={copied ? 'check' : 'copy'} className="size-3.5" />{copied ? '복사됨' : '복사'}</button>
      <button id="selection-search" onClick={search} className={item}><Icon name="search" className="size-3.5" />검색</button>
      <button id="selection-split" onClick={beside} title="보던 화면을 그대로 두고 옆에 나란히 엽니다" className={item}><Icon name="split" className="size-3.5" />옆에서 검색</button>
    </div>
  );
}
