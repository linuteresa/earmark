// All the non-UI stuff: Supabase client, hooks, helpers.
import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────
// Supabase client
// ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const isSupabaseConfigured = !!supabase;

// ─────────────────────────────────────────────────────────────────
// useLocalStorage — write-through cache
// ─────────────────────────────────────────────────────────────────
export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn('localStorage write failed:', e); }
  }, [key, value]);
  return [value, setValue];
}

// ─────────────────────────────────────────────────────────────────
// useAuth
// ─────────────────────────────────────────────────────────────────
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) { setLoading(false); return; }

    supabase.auth.getSession().then(({ data }) => {
      setUser(data?.session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => { setUser(session?.user ?? null); }
    );
    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) console.error('Sign-in failed:', error);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  return { user, loading, signInWithGoogle, signOut };
}

// ─────────────────────────────────────────────────────────────────
// Article sync — uploads local-only articles on first sign-in,
// then mirrors local mutations to the cloud.
// ─────────────────────────────────────────────────────────────────
function rowToArticle(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author || '',
    text: row.text,
    source: row.source || '',
    url: row.url || '',
    addedAt: Number(row.added_at) || Date.now(),
    finished: !!row.finished,
  };
}

function articleToRow(article, userId) {
  return {
    id: article.id,
    user_id: userId,
    title: article.title,
    author: article.author || '',
    text: article.text,
    source: article.source || '',
    url: article.url || '',
    added_at: article.addedAt,
    finished: !!article.finished,
  };
}

export function useArticleSync({ user, articles, setArticles }) {
  const [syncState, setSyncState] = useState('idle'); // 'idle' | 'syncing' | 'synced' | 'error'
  const syncedForUser = useRef(null);
  const articlesRef = useRef(articles);
  articlesRef.current = articles;

  // On user change: reconcile cloud with local (once per user)
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    if (!user) {
      syncedForUser.current = null;
      setSyncState('idle');
      return;
    }
    if (syncedForUser.current === user.id) return;
    syncedForUser.current = user.id;
    setSyncState('syncing');

    (async () => {
      try {
        const { data: cloud, error } = await supabase
          .from('articles')
          .select('*')
          .eq('user_id', user.id)
          .order('added_at', { ascending: false });
        if (error) throw error;

        const cloudArticles = (cloud || []).map(rowToArticle);
        const cloudIds = new Set(cloudArticles.map(a => a.id));
        const localOnly = articlesRef.current.filter(a => !cloudIds.has(a.id));

        // Push any local-only articles to the cloud
        if (localOnly.length > 0) {
          const rows = localOnly.map(a => articleToRow(a, user.id));
          const { error: insErr } = await supabase.from('articles').insert(rows);
          if (insErr) console.error('Failed to push local-only articles:', insErr);
        }

        // Merge: cloud is source of truth, plus any local-only we just pushed
        const merged = [...localOnly, ...cloudArticles]
          .sort((a, b) => b.addedAt - a.addedAt);
        setArticles(merged);
        setSyncState('synced');
      } catch (e) {
        console.error('Sync failed:', e);
        setSyncState('error');
      }
    })();
  }, [user, setArticles]);

  const remoteInsert = useCallback(async (article) => {
    if (!user || !isSupabaseConfigured) return;
    const { error } = await supabase
      .from('articles')
      .insert(articleToRow(article, user.id));
    if (error) console.error('Cloud insert failed:', error);
  }, [user]);

  const remoteUpdate = useCallback(async (id, changes) => {
    if (!user || !isSupabaseConfigured) return;
    const dbChanges = {};
    if ('finished' in changes) dbChanges.finished = !!changes.finished;
    if ('title' in changes) dbChanges.title = changes.title;
    if (Object.keys(dbChanges).length === 0) return;
    const { error } = await supabase
      .from('articles')
      .update(dbChanges)
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) console.error('Cloud update failed:', error);
  }, [user]);

  const remoteDelete = useCallback(async (id) => {
    if (!user || !isSupabaseConfigured) return;
    const { error } = await supabase
      .from('articles')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) console.error('Cloud delete failed:', error);
  }, [user]);

  return { syncState, remoteInsert, remoteUpdate, remoteDelete };
}

// ─────────────────────────────────────────────────────────────────
// useSpeech — chunked synthesis for cross-browser pause/skip
// ─────────────────────────────────────────────────────────────────
export function useSpeech() {
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
    if (wasPlaying) setTimeout(() => speakAt(clamped), 60);
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
// Article fetching + parsing
// ─────────────────────────────────────────────────────────────────
export async function fetchArticleFromURL(url) {
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

// Paragraph-level patterns that mean "article content is done, stop here"
const FOOTER_STOP = [
  /^subscribe\b/i,
  /^sign[\s-]up\b/i,
  /^join\s+(our|the|my)\b/i,
  /^become\s+a\s+member\b/i,
  /^(related\s+(stories|articles|posts|reads)|more\s+from\b|read\s+next\b|you\s+might\s+also\b|recommended\s+for\s+you\b)/i,
  /^(written\s+by|about\s+the\s+author|about\s+me|author\s+bio)\b/i,
  /^follow\s+(me|us)\s+on\b/i,
  /^(if\s+you\s+(enjoyed|found|liked|loved|got\s+value\s+from)\s+this)/i,
  /^thanks?\s+for\s+reading\b/i,
  /^thank\s+you\s+for\s+reading\b/i,
  /^(get\s+(stories|articles|posts|updates|my\s+writing)\s+(like\s+this\s+)?(in|to|delivered\s+to)\s+your)/i,
  /^(member[\s-]only\s+story|this\s+is\s+a\s+member[\s-]only)/i,
  /^(published\s+in\s+·|originally\s+published\s+at\b)/i,
  /^(advertisement|sponsored\s+(content|post|by)\b)/i,
  /^(clap\s+if\s+you|if\s+this\s+(post|article|story)\s+(was|helped|resonated))/i,
  /^(want\s+to\s+(support|buy\s+me|connect))/i,
  /^(let('s|\s+me)\s+connect\b)/i,
  /^(you've?\s+reached\s+your\s+(free\s+)?article\s+limit)/i,
  /^(support\s+(my|this)\s+(work|writing|blog)\b)/i,
];

// Short standalone lines that are always noise regardless of position
const NOISE_LINE = [
  /^(home|about|contact|archive|rss|newsletter|menu|navigation|search|log\s*in|log\s*out|sign\s*in|sign\s*up)$/i,
  /^[\d,.]+\s*(claps?|likes?|views?|reads?|responses?|comments?)$/i,
  /^(\d+\s*)?(min(ute)?\s+read|minute\s+read)$/i,
  /^\d+\s*followers?$/i,
  /^(follow|unfollow|subscribe|unsubscribe|share|tweet|save|bookmark|print)$/i,
  /^(twitter|linkedin|facebook|instagram|youtube|github|medium|substack)\s*$/i,
  /^[·•\-–—|]+$/,
  /^(\s*\[[\w\s]+\]\s*)+$/, // bare link text like [Read more] [Source]
];

function stripMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')           // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')         // links → text
    .replace(/^#{1,6}\s+/gm, '')                     // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')               // bold
    .replace(/\*([^*]+)\*/g, '$1')                   // italic
    .replace(/__([^_]+)__/g, '$1')                   // bold alt
    .replace(/_([^_]+)_/g, '$1')                     // italic alt
    .replace(/`([^`]+)`/g, '$1')                     // inline code
    .replace(/^>\s*/gm, '')                          // blockquotes
    .replace(/^[-*+]\s+/gm, '')                      // bullets
    .replace(/^\d+\.\s+/gm, '')                      // numbered lists
    .replace(/^-{3,}$/gm, '')                        // horizontal rules
    .replace(/\[\^[^\]]+\]/g, '')                    // footnotes
    .replace(/~~([^~]+)~~/g, '$1');                  // strikethrough
}

function isFooterParagraph(para) {
  const first = para.split('\n')[0].trim();
  return FOOTER_STOP.some(re => re.test(first));
}

function isNoiseParagraph(para) {
  const trimmed = para.trim();
  // Always-noise short lines
  if (trimmed.length < 60 && NOISE_LINE.some(re => re.test(trimmed))) return true;
  // Cookie / GDPR banners
  if (/\b(cookie|gdpr|privacy\s+policy|terms\s+of\s+(service|use))\b/i.test(trimmed) && trimmed.length < 200) return true;
  // Pure whitespace or punctuation
  if (/^[\s\W]+$/.test(trimmed)) return true;
  return false;
}

function cleanArticleContent(raw) {
  // Split into paragraphs on double newlines
  const paragraphs = raw.split(/\n{2,}/);
  const kept = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Hit a footer marker — everything from here on is noise
    if (isFooterParagraph(trimmed)) break;

    // Skip individual noise paragraphs
    if (isNoiseParagraph(trimmed)) continue;

    kept.push(trimmed);
  }

  return kept.join('\n\n');
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
  const cleaned = cleanArticleContent(stripMarkdown(body));

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
    finished: false,
  };
}

// ─────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────
export function splitIntoSentences(text) {
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

export function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function estimateDuration(text, rate = 1) {
  const words = wordCount(text);
  const wpm = 175 * rate;
  return Math.max(1, Math.round((words / wpm) * 60));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatMinutes(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

export function relativeTime(ts) {
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

export function newArticleId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
