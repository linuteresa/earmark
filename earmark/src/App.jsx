import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Plus, Loader2,
  Link2, FileText, Volume2, Headphones, Settings2, Trash2,
  Check, AlertCircle, Gauge, Mic2, ListMusic, Sparkles,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────
const T = {
  bg: '#EFE9DD',
  bgDeep: '#E6DECC',
  bgCard: '#F7F2E6',
  ink: '#1C1410',
  inkSoft: '#3D2E25',
  inkMuted: '#8C7A66',
  inkFaint: '#B3A48E',
  accent: '#A03520',
  accentSoft: '#C44A30',
  line: '#D8CFBC',
  lineSoft: '#E4DCC8',
  highlight: '#F1E2BF',
  ok: '#5C6E3A',
};

const fontDisplay = { fontFamily: '"Fraunces", "Cormorant Garamond", Georgia, serif' };
const fontBody = { fontFamily: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif' };
const fontMono = { fontFamily: '"Geist Mono", "JetBrains Mono", monospace' };

// ─────────────────────────────────────────────────────────────────
// localStorage hook — survives across visits, falls back to memory
// ─────────────────────────────────────────────────────────────────
function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Quota exceeded or localStorage disabled — ignore
      console.warn('localStorage write failed:', e);
    }
  }, [key, value]);
  return [value, setValue];
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function splitIntoSentences(text) {
  if (!text) return [];
  const normalized = text
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, ' ¶ ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = normalized.match(/[^.!?¶]+(?:[.!?]+["'")\]]*|¶|$)/g);
  return (matches || [normalized])
    .map(s => s.replace(/¶/g, '').trim())
    .filter(s => s.length > 0);
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function estimateDuration(text, rate = 1) {
  const words = wordCount(text);
  const wpm = 175 * rate;
  return Math.max(1, Math.round((words / wpm) * 60));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatMinutes(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 4) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

// Fetch article via our own /api endpoint (no CORS, server-side cached)
async function fetchArticleFromURL(url) {
  const clean = url.trim();
  const res = await fetch(`/api/fetch-article?url=${encodeURIComponent(clean)}`);
  if (!res.ok) {
    let msg = `Couldn't fetch (status ${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const raw = await res.text();
  return parseJinaResponse(raw, clean.startsWith('http') ? clean : `https://${clean}`);
}

function parseJinaResponse(raw, url) {
  const lines = raw.split('\n');
  let title = '';
  let author = '';
  let bodyStart = -1;

  for (let i = 0; i < Math.min(30, lines.length); i++) {
    const line = lines[i];
    if (line.startsWith('Title:')) title = line.slice(6).trim();
    else if (line.startsWith('Author:')) author = line.slice(7).trim();
    else if (line.startsWith('Markdown Content:')) { bodyStart = i + 1; break; }
  }

  const body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n') : raw;

  const cleaned = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^-{3,}$/gm, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let source = 'Article';
  try {
    const u = new URL(url);
    source = u.hostname.replace(/^www\./, '');
  } catch {}

  return {
    title: title || 'Untitled article',
    author: author || '',
    text: cleaned,
    source,
    url,
    addedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────
// Speech engine
// ─────────────────────────────────────────────────────────────────
function useSpeech() {
  const [voices, setVoices] = useState([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  const sentencesRef = useRef([]);
  const voiceRef = useRef(null);
  const rateRef = useRef(1);
  const idxRef = useRef(0);
  const playingRef = useRef(false);
  const onCompleteRef = useRef(() => {});

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => {
      const all = synth.getVoices();
      const english = all.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
      const others = all.filter(v => !(v.lang && v.lang.toLowerCase().startsWith('en')));
      setVoices([...english, ...others]);
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  const speakAt = useCallback((i) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const sentences = sentencesRef.current;
    if (i >= sentences.length) {
      playingRef.current = false;
      setIsSpeaking(false);
      onCompleteRef.current();
      return;
    }
    idxRef.current = i;
    setCurrentIndex(i);

    const u = new SpeechSynthesisUtterance(sentences[i]);
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = rateRef.current;
    u.pitch = 1;
    u.onend = () => {
      if (!playingRef.current) return;
      speakAt(idxRef.current + 1);
    };
    u.onerror = (e) => {
      if (e.error && e.error !== 'interrupted' && e.error !== 'canceled') {
        playingRef.current = false;
        setIsSpeaking(false);
      }
    };
    synth.speak(u);
  }, []);

  const load = useCallback((sentences) => {
    window.speechSynthesis?.cancel();
    sentencesRef.current = sentences;
    idxRef.current = 0;
    setCurrentIndex(0);
    playingRef.current = false;
    setIsSpeaking(false);
  }, []);

  const play = useCallback(() => {
    if (!sentencesRef.current.length) return;
    if (playingRef.current) return;
    playingRef.current = true;
    setIsSpeaking(true);
    speakAt(idxRef.current);
  }, [speakAt]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setIsSpeaking(false);
    window.speechSynthesis?.cancel();
  }, []);

  const seek = useCallback((i) => {
    const sentences = sentencesRef.current;
    const clamped = Math.max(0, Math.min(sentences.length - 1, i));
    const wasPlaying = playingRef.current;
    window.speechSynthesis?.cancel();
    idxRef.current = clamped;
    setCurrentIndex(clamped);
    if (wasPlaying) {
      setTimeout(() => speakAt(clamped), 60);
    }
  }, [speakAt]);

  const skipForward = useCallback(() => seek(idxRef.current + 2), [seek]);
  const skipBack = useCallback(() => seek(idxRef.current - 2), [seek]);

  const setVoice = useCallback((v) => {
    voiceRef.current = v;
    if (playingRef.current) seek(idxRef.current);
  }, [seek]);

  const setRate = useCallback((r) => {
    rateRef.current = r;
    if (playingRef.current) seek(idxRef.current);
  }, [seek]);

  const setOnComplete = useCallback((fn) => { onCompleteRef.current = fn; }, []);

  return {
    voices, isSpeaking, currentIndex,
    load, play, pause, seek, skipForward, skipBack,
    setVoice, setRate, setOnComplete,
  };
}

// ─────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────
function FontsAndStyles() {
  useEffect(() => {
    const id = 'earmark-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,400;1,9..144,500;1,9..144,700&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }, []);
  return (
    <style>{`
      @keyframes em-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.5 } }
      @keyframes em-bar { 0%, 100% { transform: scaleY(0.4) } 50% { transform: scaleY(1) } }
      @keyframes em-fade-up { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
      .em-fade-up { animation: em-fade-up 0.5s ease-out backwards }
      .em-bar { transform-origin: bottom; animation: em-bar 1s ease-in-out infinite }
      .em-bar:nth-child(2) { animation-delay: 0.15s }
      .em-bar:nth-child(3) { animation-delay: 0.3s }
      .em-bar:nth-child(4) { animation-delay: 0.45s }
      .em-scroll::-webkit-scrollbar { width: 6px }
      .em-scroll::-webkit-scrollbar-track { background: transparent }
      .em-scroll::-webkit-scrollbar-thumb { background: ${T.inkFaint}; border-radius: 3px }
      input.em-input::placeholder, textarea.em-input::placeholder { color: ${T.inkFaint} }
      .em-btn-press:active { transform: scale(0.96) }
    `}</style>
  );
}

function PlayingBars({ color = T.bgCard }) {
  return (
    <div className="flex items-end gap-0.5" style={{ height: 14, width: 16 }}>
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="em-bar" style={{ width: 3, height: '100%', background: color, borderRadius: 1 }} />
      ))}
    </div>
  );
}

function AddArticle({ onAdd }) {
  const [mode, setMode] = useState('url');
  const [url, setUrl] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const submitUrl = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const article = await fetchArticleFromURL(url);
      if (!article.text || article.text.length < 50) {
        throw new Error('Got the page but it was empty. Try paste mode below.');
      }
      onAdd(article);
      setUrl('');
      setSuccess(`Added "${article.title.slice(0, 40)}${article.title.length > 40 ? '…' : ''}"`);
      setTimeout(() => setSuccess(''), 2500);
    } catch (e) {
      setError(e.message || 'Could not fetch that URL. Try paste mode below.');
    } finally {
      setLoading(false);
    }
  };

  const submitPaste = () => {
    if (!pasteText.trim()) return;
    onAdd({
      title: pasteTitle.trim() || 'Pasted article',
      author: '',
      text: pasteText.trim(),
      source: 'Pasted',
      url: '',
      addedAt: Date.now(),
    });
    setPasteText('');
    setPasteTitle('');
    setSuccess('Added to your reading list');
    setTimeout(() => setSuccess(''), 2500);
  };

  return (
    <div
      className="rounded-2xl p-5 em-fade-up"
      style={{
        background: T.bgCard,
        border: `1px solid ${T.line}`,
        boxShadow: `0 1px 0 ${T.lineSoft}, 0 12px 28px -20px rgba(28,20,16,0.25)`,
      }}
    >
      <div className="flex items-center gap-3 mb-4">
        <div
          className="flex items-center gap-1 p-1 rounded-full"
          style={{ background: T.bgDeep, border: `1px solid ${T.line}` }}
        >
          <button
            onClick={() => { setMode('url'); setError(''); }}
            className="em-btn-press flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-all"
            style={{
              ...fontBody,
              background: mode === 'url' ? T.ink : 'transparent',
              color: mode === 'url' ? T.bgCard : T.inkSoft,
              fontWeight: 500,
            }}
          >
            <Link2 size={12} /> Paste a link
          </button>
          <button
            onClick={() => { setMode('paste'); setError(''); }}
            className="em-btn-press flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-all"
            style={{
              ...fontBody,
              background: mode === 'paste' ? T.ink : 'transparent',
              color: mode === 'paste' ? T.bgCard : T.inkSoft,
              fontWeight: 500,
            }}
          >
            <FileText size={12} /> Paste text
          </button>
        </div>
      </div>

      {mode === 'url' ? (
        <div>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && submitUrl()}
              placeholder="https://medium.com/..."
              disabled={loading}
              className="em-input flex-1 px-4 py-3 rounded-xl text-sm outline-none transition-colors"
              style={{
                ...fontBody,
                background: T.bg,
                color: T.ink,
                border: `1px solid ${T.line}`,
              }}
              onFocus={e => e.target.style.borderColor = T.accent}
              onBlur={e => e.target.style.borderColor = T.line}
            />
            <button
              onClick={submitUrl}
              disabled={loading || !url.trim()}
              className="em-btn-press flex items-center gap-2 px-5 py-3 rounded-xl text-sm transition-all disabled:opacity-50"
              style={{
                ...fontBody,
                background: T.accent,
                color: T.bgCard,
                fontWeight: 600,
              }}
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {loading ? 'Fetching' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={pasteTitle}
            onChange={e => setPasteTitle(e.target.value)}
            placeholder="Title (optional)"
            className="em-input w-full px-4 py-3 rounded-xl text-sm outline-none"
            style={{ ...fontBody, background: T.bg, color: T.ink, border: `1px solid ${T.line}` }}
          />
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder="Paste the article text here..."
            rows={6}
            className="em-input w-full px-4 py-3 rounded-xl text-sm outline-none resize-none"
            style={{ ...fontBody, background: T.bg, color: T.ink, border: `1px solid ${T.line}`, lineHeight: 1.6 }}
          />
          <div className="flex justify-end">
            <button
              onClick={submitPaste}
              disabled={!pasteText.trim()}
              className="em-btn-press flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm transition-all disabled:opacity-50"
              style={{ ...fontBody, background: T.accent, color: T.bgCard, fontWeight: 600 }}
            >
              <Plus size={16} /> Save to list
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 text-xs" style={{ ...fontBody, color: T.accent }}>
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mt-3 flex items-center gap-2 text-xs" style={{ ...fontBody, color: T.ok }}>
          <Check size={14} className="flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}
    </div>
  );
}

function PlayerCard({
  article, sentences, currentIndex, isSpeaking,
  onPlay, onPause, onSkipBack, onSkipForward, onSeek,
  rate, onRateChange,
  voices, currentVoice, onVoiceChange,
  totalCount, finishedCount,
}) {
  const [showSettings, setShowSettings] = useState(false);

  const totalDuration = useMemo(
    () => estimateDuration(article?.text || '', rate),
    [article, rate]
  );

  const wordsBefore = useMemo(() => {
    if (!sentences.length) return 0;
    return sentences.slice(0, currentIndex).reduce((sum, s) => sum + wordCount(s), 0);
  }, [sentences, currentIndex]);

  const totalWords = useMemo(
    () => sentences.reduce((sum, s) => sum + wordCount(s), 0),
    [sentences]
  );

  const elapsed = totalWords > 0
    ? Math.round((wordsBefore / totalWords) * totalDuration)
    : 0;
  const remaining = Math.max(0, totalDuration - elapsed);
  const progress = sentences.length > 0 ? currentIndex / sentences.length : 0;

  if (!article) {
    return (
      <div
        className="rounded-3xl p-10 text-center em-fade-up"
        style={{
          background: T.bgCard,
          border: `1px solid ${T.line}`,
          boxShadow: `0 1px 0 ${T.lineSoft}, 0 12px 28px -20px rgba(28,20,16,0.25)`,
        }}
      >
        <Headphones size={32} style={{ color: T.inkFaint }} className="mx-auto mb-4" />
        <h2 className="text-2xl mb-2" style={{ ...fontDisplay, color: T.ink, fontWeight: 500 }}>
          {totalCount === 0 ? 'Your reading list is quiet.' : 'Pick something to listen to.'}
        </h2>
        <p className="text-sm" style={{ ...fontBody, color: T.inkMuted }}>
          {totalCount === 0
            ? 'Paste a Medium URL above to start your reading list.'
            : `${totalCount - finishedCount} unread, ${finishedCount} finished. Tap an article below.`}
        </p>
      </div>
    );
  }

  const windowSize = 2;
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(sentences.length, currentIndex + windowSize + 1);
  const visibleSentences = sentences.slice(start, end).map((s, i) => ({
    text: s,
    index: start + i,
    isCurrent: start + i === currentIndex,
  }));

  return (
    <div
      className="rounded-3xl overflow-hidden em-fade-up"
      style={{
        background: T.bgCard,
        border: `1px solid ${T.line}`,
        boxShadow: `0 1px 0 ${T.lineSoft}, 0 24px 48px -28px rgba(28,20,16,0.4)`,
      }}
    >
      <div
        className="px-7 pt-6 pb-4 flex items-center justify-between"
        style={{ borderBottom: `1px solid ${T.lineSoft}` }}
      >
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest" style={{ ...fontMono, color: T.inkMuted }}>
          <span style={{
            width: 6, height: 6, borderRadius: 3,
            background: isSpeaking ? T.accent : T.inkFaint,
            animation: isSpeaking ? 'em-pulse 1.5s infinite' : 'none',
          }} />
          {isSpeaking ? 'Now reading' : 'Ready to play'} · {article.source}
        </div>
        <button
          onClick={() => setShowSettings(s => !s)}
          className="em-btn-press p-2 rounded-lg transition-colors"
          style={{ color: T.inkMuted }}
          onMouseEnter={e => e.currentTarget.style.background = T.bgDeep}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <Settings2 size={16} />
        </button>
      </div>

      {showSettings && (
        <div
          className="px-7 py-5 em-fade-up"
          style={{ background: T.bgDeep, borderBottom: `1px solid ${T.lineSoft}` }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="flex items-center gap-2 text-xs uppercase tracking-widest mb-2" style={{ ...fontMono, color: T.inkMuted }}>
                <Mic2 size={11} /> Voice
              </label>
              <select
                value={currentVoice?.name || ''}
                onChange={e => {
                  const v = voices.find(x => x.name === e.target.value);
                  onVoiceChange(v);
                }}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ ...fontBody, background: T.bgCard, color: T.ink, border: `1px solid ${T.line}` }}
              >
                {voices.length === 0 && <option>Loading voices…</option>}
                {voices.map(v => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.lang}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 text-xs uppercase tracking-widest mb-2" style={{ ...fontMono, color: T.inkMuted }}>
                <Gauge size={11} /> Speed · {rate.toFixed(2)}×
              </label>
              <div className="flex items-center gap-1">
                {[0.75, 1, 1.25, 1.5, 1.75, 2].map(r => (
                  <button
                    key={r}
                    onClick={() => onRateChange(r)}
                    className="em-btn-press flex-1 px-2 py-2 rounded-lg text-xs transition-all"
                    style={{
                      ...fontMono,
                      background: rate === r ? T.ink : T.bgCard,
                      color: rate === r ? T.bgCard : T.inkSoft,
                      border: `1px solid ${rate === r ? T.ink : T.line}`,
                      fontWeight: 500,
                    }}
                  >
                    {r}×
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="px-7 pt-8">
        <h2
          className="leading-[1.05] mb-3"
          style={{
            ...fontDisplay,
            color: T.ink,
            fontSize: 'clamp(28px, 4vw, 44px)',
            fontWeight: 500,
            letterSpacing: '-0.02em',
          }}
        >
          {article.title}
        </h2>
        <div className="flex items-center gap-3 text-sm" style={{ ...fontBody, color: T.inkMuted }}>
          {article.author && (
            <span style={{ ...fontDisplay, fontStyle: 'italic', color: T.inkSoft }}>
              by {article.author}
            </span>
          )}
          {article.author && <span style={{ color: T.inkFaint }}>·</span>}
          <span style={{ ...fontMono, fontSize: 12 }}>
            {formatMinutes(totalDuration)} listen
          </span>
        </div>
      </div>

      <div className="px-7 py-7">
        <div
          className="rounded-2xl px-6 py-6 min-h-[140px]"
          style={{ background: T.bg, border: `1px solid ${T.lineSoft}` }}
        >
          {visibleSentences.length === 0 ? (
            <p style={{ ...fontDisplay, fontStyle: 'italic', color: T.inkFaint, fontSize: 18 }}>
              Press play to begin…
            </p>
          ) : (
            <p
              className="leading-relaxed"
              style={{ ...fontDisplay, color: T.inkFaint, fontSize: 19, lineHeight: 1.55 }}
            >
              {visibleSentences.map((s) => (
                <span
                  key={s.index}
                  onClick={() => onSeek(s.index)}
                  className="cursor-pointer transition-colors"
                  style={{
                    color: s.isCurrent ? T.ink : T.inkFaint,
                    background: s.isCurrent ? T.highlight : 'transparent',
                    padding: s.isCurrent ? '0 4px' : '0',
                    borderRadius: 4,
                    fontWeight: s.isCurrent ? 500 : 400,
                  }}
                >
                  {s.text}{' '}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>

      <div className="px-7 pb-2">
        <div
          className="relative h-1.5 rounded-full cursor-pointer"
          style={{ background: T.lineSoft }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            onSeek(Math.floor(ratio * sentences.length));
          }}
        >
          <div
            className="absolute top-0 left-0 h-full rounded-full transition-all"
            style={{ width: `${progress * 100}%`, background: T.accent }}
          />
          <div
            className="absolute top-1/2 rounded-full transition-all"
            style={{
              left: `${progress * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 12, height: 12,
              background: T.accent,
              border: `2px solid ${T.bgCard}`,
              boxShadow: '0 2px 6px rgba(160,53,32,0.4)',
            }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs" style={{ ...fontMono, color: T.inkMuted }}>
          <span>{formatTime(elapsed)}</span>
          <span>−{formatTime(remaining)}</span>
        </div>
      </div>

      <div className="px-7 pb-7 pt-2 flex items-center justify-center gap-3">
        <button
          onClick={onSkipBack}
          className="em-btn-press p-3 rounded-full transition-all"
          style={{ color: T.inkSoft }}
          onMouseEnter={e => e.currentTarget.style.background = T.bgDeep}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title="Back a couple sentences"
        >
          <SkipBack size={22} fill={T.inkSoft} />
        </button>

        <button
          onClick={isSpeaking ? onPause : onPlay}
          className="em-btn-press flex items-center justify-center rounded-full transition-all"
          style={{
            background: T.accent,
            color: T.bgCard,
            width: 64, height: 64,
            boxShadow: '0 8px 20px -6px rgba(160,53,32,0.55), inset 0 1px 0 rgba(255,255,255,0.15)',
          }}
        >
          {isSpeaking
            ? <Pause size={24} fill={T.bgCard} />
            : <Play size={24} fill={T.bgCard} style={{ marginLeft: 3 }} />}
        </button>

        <button
          onClick={onSkipForward}
          className="em-btn-press p-3 rounded-full transition-all"
          style={{ color: T.inkSoft }}
          onMouseEnter={e => e.currentTarget.style.background = T.bgDeep}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title="Forward a couple sentences"
        >
          <SkipForward size={22} fill={T.inkSoft} />
        </button>
      </div>
    </div>
  );
}

function ListItem({ article, isCurrent, isPlaying, isFinished, rate, onSelect, onRemove, onToggleFinished }) {
  const duration = useMemo(
    () => estimateDuration(article.text, rate),
    [article.text, rate]
  );

  return (
    <div
      className="group rounded-xl p-4 transition-all cursor-pointer flex items-start gap-3"
      style={{
        background: isCurrent ? T.bgDeep : T.bgCard,
        border: `1px solid ${isCurrent ? T.line : T.lineSoft}`,
        opacity: isFinished && !isCurrent ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = T.bgDeep; }}
      onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = T.bgCard; }}
      onClick={onSelect}
    >
      <div
        className="flex-shrink-0 flex items-center justify-center rounded-lg"
        style={{
          width: 40, height: 40,
          background: isCurrent ? T.accent : (isFinished ? T.bgDeep : T.bgDeep),
          color: isCurrent ? T.bgCard : T.inkSoft,
          border: `1px solid ${isCurrent ? T.accent : T.line}`,
        }}
      >
        {isCurrent && isPlaying ? <PlayingBars /> :
          isCurrent ? <Pause size={16} fill={T.bgCard} /> :
          isFinished ? <Check size={16} style={{ color: T.ok }} /> :
          <Play size={14} fill={T.inkSoft} style={{ marginLeft: 2 }} />}
      </div>

      <div className="flex-1 min-w-0">
        <h3
          className="leading-tight mb-1"
          style={{
            ...fontDisplay,
            color: T.ink,
            fontSize: 16,
            fontWeight: 500,
            textDecoration: isFinished && !isCurrent ? 'line-through' : 'none',
            textDecorationColor: T.inkFaint,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {article.title}
        </h3>
        <div className="flex items-center gap-2 text-xs flex-wrap" style={{ ...fontBody, color: T.inkMuted }}>
          {article.author && (
            <>
              <span style={{ fontStyle: 'italic' }}>{article.author}</span>
              <span style={{ color: T.inkFaint }}>·</span>
            </>
          )}
          <span style={{ ...fontMono }}>{formatMinutes(duration)}</span>
          <span style={{ color: T.inkFaint }}>·</span>
          <span style={{ color: T.inkFaint }}>{relativeTime(article.addedAt)}</span>
          {isFinished && !isCurrent && (
            <>
              <span style={{ color: T.inkFaint }}>·</span>
              <span style={{ color: T.ok, fontWeight: 500 }}>heard</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button
          onClick={e => { e.stopPropagation(); onToggleFinished(); }}
          className="em-btn-press p-1.5 rounded-md transition-all"
          style={{ color: T.inkMuted }}
          onMouseEnter={e => { e.currentTarget.style.background = T.bg; e.currentTarget.style.color = T.ok; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.inkMuted; }}
          title={isFinished ? 'Mark as unread' : 'Mark as heard'}
        >
          <Check size={14} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="em-btn-press p-1.5 rounded-md transition-all"
          style={{ color: T.inkMuted }}
          onMouseEnter={e => { e.currentTarget.style.background = T.bg; e.currentTarget.style.color = T.accent; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.inkMuted; }}
          title="Remove from list"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [articles, setArticles] = useLocalStorage('earmark.articles', []);
  const [currentId, setCurrentId] = useLocalStorage('earmark.currentId', null);
  const [rate, setRate] = useLocalStorage('earmark.rate', 1);
  const [voiceName, setVoiceName] = useLocalStorage('earmark.voiceName', null);
  const [finishedIds, setFinishedIds] = useLocalStorage('earmark.finishedIds', []);
  const [showFinished, setShowFinished] = useLocalStorage('earmark.showFinished', true);

  const [currentVoice, setCurrentVoice] = useState(null);

  const speech = useSpeech();
  const { voices } = speech;

  // Apply persisted rate
  useEffect(() => { speech.setRate(rate); }, [rate, speech]);

  // Pick voice once voices load
  useEffect(() => {
    if (voices.length === 0) return;
    // Try saved voice first
    if (voiceName) {
      const saved = voices.find(v => v.name === voiceName);
      if (saved) {
        setCurrentVoice(saved);
        speech.setVoice(saved);
        return;
      }
    }
    // Fall back to a preferred default
    const preferred = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Google US English', 'Microsoft Aria', 'Alex'];
    const pick = preferred
      .map(name => voices.find(v => v.name.includes(name)))
      .find(Boolean) || voices[0];
    setCurrentVoice(pick);
    speech.setVoice(pick);
    setVoiceName(pick.name);
  }, [voices]); // eslint-disable-line

  const currentArticle = articles.find(a => a.id === currentId) || null;

  const sentences = useMemo(
    () => currentArticle ? splitIntoSentences(currentArticle.text) : [],
    [currentArticle]
  );

  useEffect(() => {
    speech.load(sentences);
  }, [sentences]); // eslint-disable-line

  // Mark finished + auto-advance
  useEffect(() => {
    speech.setOnComplete(() => {
      // Mark current as heard
      if (currentId) {
        setFinishedIds(prev => prev.includes(currentId) ? prev : [...prev, currentId]);
      }
      // Auto-advance to next unfinished
      const finishedSet = new Set([...(finishedIds || []), currentId]);
      const remaining = articles.filter(a => !finishedSet.has(a.id) && a.id !== currentId);
      if (remaining.length > 0) {
        const next = remaining[0];
        setCurrentId(next.id);
        setTimeout(() => speech.play(), 200);
      }
    });
  }, [articles, currentId, finishedIds, speech, setFinishedIds, setCurrentId]);

  const handleAdd = useCallback((article) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const withId = { ...article, id };
    setArticles(prev => [withId, ...prev]); // newest first
    if (!currentId) setCurrentId(id);
  }, [currentId, setArticles, setCurrentId]);

  const handleRemove = useCallback((id) => {
    setArticles(prev => prev.filter(a => a.id !== id));
    setFinishedIds(prev => prev.filter(x => x !== id));
    if (id === currentId) {
      speech.pause();
      setCurrentId(null);
    }
  }, [currentId, speech, setArticles, setFinishedIds, setCurrentId]);

  const handleSelect = useCallback((id) => {
    if (id === currentId) {
      speech.isSpeaking ? speech.pause() : speech.play();
    } else {
      speech.pause();
      setCurrentId(id);
      setTimeout(() => speech.play(), 200);
    }
  }, [currentId, speech, setCurrentId]);

  const handleToggleFinished = useCallback((id) => {
    setFinishedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, [setFinishedIds]);

  const handleRateChange = useCallback((r) => {
    setRate(r);
    speech.setRate(r);
  }, [speech, setRate]);

  const handleVoiceChange = useCallback((v) => {
    setCurrentVoice(v);
    setVoiceName(v?.name || null);
    speech.setVoice(v);
  }, [speech, setVoiceName]);

  const handleClearFinished = useCallback(() => {
    if (!finishedIds.length) return;
    if (!window.confirm(`Remove ${finishedIds.length} finished article(s) from your list?`)) return;
    setArticles(prev => prev.filter(a => !finishedIds.includes(a.id)));
    setFinishedIds([]);
  }, [finishedIds, setArticles, setFinishedIds]);

  const finishedSet = useMemo(() => new Set(finishedIds), [finishedIds]);
  const unread = articles.filter(a => !finishedSet.has(a.id) && a.id !== currentId);
  const finished = articles.filter(a => finishedSet.has(a.id) && a.id !== currentId);

  return (
    <div
      className="min-h-screen w-full"
      style={{
        ...fontBody,
        background: T.bg,
        color: T.ink,
        backgroundImage: `
          radial-gradient(at 20% 10%, ${T.bgDeep} 0%, transparent 45%),
          radial-gradient(at 90% 80%, ${T.bgDeep} 0%, transparent 55%),
          radial-gradient(rgba(28,20,16,0.03) 1px, transparent 1px)
        `,
        backgroundSize: 'auto, auto, 3px 3px',
      }}
    >
      <FontsAndStyles />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <header className="flex items-center justify-between mb-8 em-fade-up">
          <div className="flex items-baseline gap-3">
            <h1
              style={{
                ...fontDisplay,
                color: T.ink,
                fontSize: 32,
                fontWeight: 500,
                letterSpacing: '-0.03em',
              }}
            >
              Earmark
            </h1>
            <span
              className="hidden sm:inline text-xs uppercase tracking-[0.2em]"
              style={{ ...fontMono, color: T.inkMuted }}
            >
              · listen to anything
            </span>
          </div>
          <div
            className="flex items-center gap-2 text-xs"
            style={{ ...fontMono, color: T.inkMuted }}
          >
            <Volume2 size={12} />
            {articles.length} saved
          </div>
        </header>

        <p
          className="mb-8 em-fade-up"
          style={{
            ...fontDisplay,
            fontStyle: 'italic',
            color: T.inkSoft,
            fontSize: 18,
            animationDelay: '0.05s',
          }}
        >
          Save your reading list, then listen to it whenever you like.
        </p>

        <div className="mb-8" style={{ animationDelay: '0.1s' }}>
          <AddArticle onAdd={handleAdd} />
        </div>

        <div className="mb-8" style={{ animationDelay: '0.15s' }}>
          <PlayerCard
            article={currentArticle}
            sentences={sentences}
            currentIndex={speech.currentIndex}
            isSpeaking={speech.isSpeaking}
            onPlay={speech.play}
            onPause={speech.pause}
            onSkipBack={speech.skipBack}
            onSkipForward={speech.skipForward}
            onSeek={speech.seek}
            rate={rate}
            onRateChange={handleRateChange}
            voices={voices}
            currentVoice={currentVoice}
            onVoiceChange={handleVoiceChange}
            totalCount={articles.length}
            finishedCount={finishedIds.length}
          />
        </div>

        {unread.length > 0 && (
          <div className="em-fade-up mb-8" style={{ animationDelay: '0.2s' }}>
            <div className="flex items-center gap-3 mb-3 px-1">
              <ListMusic size={14} style={{ color: T.inkMuted }} />
              <h3
                className="text-xs uppercase tracking-[0.25em]"
                style={{ ...fontMono, color: T.inkMuted, fontWeight: 500 }}
              >
                Reading List
              </h3>
              <div className="flex-1 h-px" style={{ background: T.line }} />
              <span className="text-xs" style={{ ...fontMono, color: T.inkFaint }}>
                {unread.length}
              </span>
            </div>
            <div className="space-y-2">
              {unread.map(a => (
                <ListItem
                  key={a.id}
                  article={a}
                  isCurrent={false}
                  isPlaying={false}
                  isFinished={false}
                  rate={rate}
                  onSelect={() => handleSelect(a.id)}
                  onRemove={() => handleRemove(a.id)}
                  onToggleFinished={() => handleToggleFinished(a.id)}
                />
              ))}
            </div>
          </div>
        )}

        {finished.length > 0 && (
          <div className="em-fade-up" style={{ animationDelay: '0.25s' }}>
            <div className="flex items-center gap-3 mb-3 px-1">
              <Check size={14} style={{ color: T.inkMuted }} />
              <button
                onClick={() => setShowFinished(s => !s)}
                className="text-xs uppercase tracking-[0.25em] cursor-pointer"
                style={{ ...fontMono, color: T.inkMuted, fontWeight: 500 }}
              >
                Heard {showFinished ? '−' : '+'}
              </button>
              <div className="flex-1 h-px" style={{ background: T.line }} />
              <span className="text-xs" style={{ ...fontMono, color: T.inkFaint }}>
                {finished.length}
              </span>
              <button
                onClick={handleClearFinished}
                className="text-xs em-btn-press"
                style={{ ...fontMono, color: T.inkMuted }}
                onMouseEnter={e => e.currentTarget.style.color = T.accent}
                onMouseLeave={e => e.currentTarget.style.color = T.inkMuted}
              >
                clear
              </button>
            </div>
            {showFinished && (
              <div className="space-y-2">
                {finished.map(a => (
                  <ListItem
                    key={a.id}
                    article={a}
                    isCurrent={false}
                    isPlaying={false}
                    isFinished={true}
                    rate={rate}
                    onSelect={() => handleSelect(a.id)}
                    onRemove={() => handleRemove(a.id)}
                    onToggleFinished={() => handleToggleFinished(a.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <footer
          className="mt-12 pt-6 text-xs text-center"
          style={{ ...fontBody, color: T.inkFaint, borderTop: `1px solid ${T.lineSoft}` }}
        >
          <Sparkles size={10} style={{ display: 'inline', marginRight: 6, verticalAlign: '-1px' }} />
          Your reading list lives in this browser · TTS by your operating system · Article extraction by Jina Reader
        </footer>
      </div>
    </div>
  );
}
