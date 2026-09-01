// Renderer (UI) logic for linux-freewrite.
//
// This file runs in the sandboxed page. It never touches the filesystem
// directly; all persistence goes through window.freewrite.* (see preload.js).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// AI reflection prompts, copied verbatim from the macOS app (ContentView.swift)
// so all three platforms send the maintainer's exact wording.
const aiChatPrompt = `below is my journal entry. wyt? talk through it with me like a friend. don't therpaize me and give me a whole breakdown, don't repeat my thoughts with headings. really take all of this, and tell me back stuff truly as if you're an old homie.

Keep it casual, dont say yo, help me make new connections i don't see, comfort, validate, challenge, all of it. dont be afraid to say a lot. format with markdown headings if needed.

do not just go through every single thing i say, and say it back to me. you need to proccess everythikng is say, make connections i don't see it, and deliver it all back to me as a story that makes me feel what you think i wanna feel. thats what the best therapists do.

ideally, you're style/tone should sound like the user themselves. it's as if the user is hearing their own tone but it should still feel different, because you have different things to say and don't just repeat back they say.

else, start by saying, "hey, thanks for showing me this. my thoughts:"
    
my entry:`;

const claudePrompt = `Take a look at my journal entry below. I'd like you to analyze it and respond with deep insight that feels personal, not clinical.
Imagine you're not just a friend, but a mentor who truly gets both my tech background and my psychological patterns. I want you to uncover the deeper meaning and emotional undercurrents behind my scattered thoughts.
Keep it casual, dont say yo, help me make new connections i don't see, comfort, validate, challenge, all of it. dont be afraid to say a lot. format with markdown headings if needed.
Use vivid metaphors and powerful imagery to help me see what I'm really building. Organize your thoughts with meaningful headings that create a narrative journey through my ideas.
Don't just validate my thoughts - reframe them in a way that shows me what I'm really seeking beneath the surface. Go beyond the product concepts to the emotional core of what I'm trying to solve.
Be willing to be profound and philosophical without sounding like you're giving therapy. I want someone who can see the patterns I can't see myself and articulate them in a way that feels like an epiphany.
Start with 'hey, thanks for showing me this. my thoughts:' and then use markdown headings to structure your response.

Here's my journal entry:`;

// If a chat URL would exceed this many characters, browsers can choke, so we
// fall back to copying the prompt to the clipboard instead.
const MAX_URL_LENGTH = 6000;

const FONT_SIZES = [16, 18, 20, 22, 24, 26];

// Font choices. Lato is bundled (see styles.css @font-face); the rest are
// families that ship on essentially every Linux desktop.
const FONT_FAMILIES = {
  lato: "'Lato', sans-serif",
  system: 'system-ui, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', monospace",
};
const RANDOM_FONTS = ['Georgia', 'Palatino', 'Garamond', 'Courier New', 'Verdana', 'Trebuchet MS'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let entries = [];          // [{ id, filename, timestamp, content, previewText, date }]
let selectedEntry = null;
let settings = {};         // { theme, fontKind, fontSize, randomFont }

let fontSize = 18;
let fontKind = 'lato';
let randomFont = RANDOM_FONTS[0];

let timeRemaining = 900;   // 15:00
let timerIsRunning = false;
let timerInterval = null;
let timerClickTimer = null;

let backspaceDisabled = false;
let saveTimer = null;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const editor = document.getElementById('editor');
const notice = document.getElementById('notice');
const toolbar = document.getElementById('toolbar');

const fontSizeBtn = document.getElementById('font-size-btn');
const fontSizePopup = document.getElementById('font-size-popup');
const fontButtons = {
  lato: document.getElementById('font-lato'),
  system: document.getElementById('font-system'),
  serif: document.getElementById('font-serif'),
  mono: document.getElementById('font-mono'),
  random: document.getElementById('font-random'),
};

const timerBtn = document.getElementById('timer-btn');
const themeBtn = document.getElementById('theme-btn');
const chatBtn = document.getElementById('chat-btn');
const chatPopup = document.getElementById('chat-popup');
const backspaceBtn = document.getElementById('backspace-btn');
const pdfBtn = document.getElementById('pdf-btn');
const newEntryBtn = document.getElementById('new-entry-btn');
const historyBtn = document.getElementById('history-btn');

const sidebar = document.getElementById('sidebar');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const entriesList = document.getElementById('entries-list');

// ---------------------------------------------------------------------------
// Helpers: filenames, dates, previews (format must match mac/Windows)
// ---------------------------------------------------------------------------

// Uppercase UUID to match the macOS-generated filenames, e.g.
// [6910BBDE-75FC-415C-ABB9-C76644B037B2].
function generateUUID() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  // Fallback (older engines): RFC-4122 v4-ish.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
    .toUpperCase();
}

// Build "YYYY-MM-DD-HH-mm-ss" from a Date (local time, zero-padded).
function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

// The canonical entry filename: [UUID]-[timestamp].md
function makeFilename(uuid, timestamp) {
  return `[${uuid}]-[${timestamp}].md`;
}

// Parse a "YYYY-MM-DD-HH-mm-ss" string into a Date.
function parseTimestamp(ts) {
  const [y, mo, d, h, mi, s] = ts.split('-').map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

// Sidebar display date, e.g. "Feb 20".
function displayDate(ts) {
  return parseTimestamp(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Sidebar preview: newlines collapsed to spaces, first ~30 chars.
function makePreview(content) {
  const flat = content.replace(/\n/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > 30 ? flat.slice(0, 30) + '...' : flat;
}

// An entry is "empty" if it has no real text (just the leading whitespace).
function isEmpty(content) {
  return content.trim() === '';
}

// Was this entry created today (local calendar day)?
function isToday(ts) {
  const d = parseTimestamp(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Attach derived display fields to an entry object.
function decorate(entry) {
  entry.previewText = makePreview(entry.content || '');
  entry.date = displayDate(entry.timestamp);
  return entry;
}

// ---------------------------------------------------------------------------
// Entry loading / launch selection
// ---------------------------------------------------------------------------

async function init() {
  await loadSettings();
  wireEvents();

  entries = (await window.freewrite.listEntries()).map(decorate);

  // Launch selection rules (mirrors the macOS app):
  //   1. No entries ever  -> seed the welcome entry.
  //   2. No EMPTY entry from today -> create a fresh empty entry.
  //   3. Otherwise -> reuse today's most recent empty entry.
  if (entries.length === 0) {
    await createWelcomeEntry();
  } else {
    const emptyToday = entries.filter((e) => isToday(e.timestamp) && isEmpty(e.content));
    if (emptyToday.length === 0) {
      await createNewEntry();
    } else {
      selectEntry(emptyToday[0]); // list is newest-first, so [0] is most recent
    }
  }

  renderEntries();
}

// Create a brand-new empty entry (starts with the two-newline breathing room).
async function createNewEntry() {
  const uuid = generateUUID();
  const timestamp = formatTimestamp(new Date());
  const entry = decorate({
    id: uuid,
    filename: makeFilename(uuid, timestamp),
    timestamp,
    content: '\n\n',
  });

  // Persist immediately so the empty entry survives relaunch and the
  // "reuse today's empty entry" rule can find it.
  await window.freewrite.saveEntry(entry.filename, entry.content);

  entries.unshift(entry);
  selectEntry(entry);
  renderEntries();
  editor.focus();
}

// First-ever launch: seed the onboarding entry from the bundled default.md.
async function createWelcomeEntry() {
  const welcome = await window.freewrite.getWelcomeText();
  const uuid = generateUUID();
  const timestamp = formatTimestamp(new Date());
  const entry = decorate({
    id: uuid,
    filename: makeFilename(uuid, timestamp),
    timestamp,
    content: '\n\n' + welcome,
  });

  await window.freewrite.saveEntry(entry.filename, entry.content);

  entries.unshift(entry);
  selectEntry(entry);
  renderEntries();
}

// Load an entry into the editor (flushing any pending save on the old one).
function selectEntry(entry) {
  if (selectedEntry && selectedEntry.filename !== entry.filename) {
    flushSave();
  }
  selectedEntry = entry;
  editor.value = entry.content;
  applyBackspaceState(); // re-apply, harmless
  renderEntries();
}

// ---------------------------------------------------------------------------
// Auto-save (debounced 300ms)
// ---------------------------------------------------------------------------

function scheduleSave() {
  if (!selectedEntry) return;
  // Update the in-memory cache + live preview right away for responsiveness.
  selectedEntry.content = editor.value;
  decorate(selectedEntry);
  renderEntries();

  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

function flushSave() {
  if (!selectedEntry) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  // Fire-and-forget; the main process writes synchronously to disk.
  window.freewrite.saveEntry(selectedEntry.filename, selectedEntry.content);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function deleteEntry(entry) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;

  await window.freewrite.deleteEntry(entry.filename);
  entries = entries.filter((e) => e.filename !== entry.filename);

  if (selectedEntry && selectedEntry.filename === entry.filename) {
    selectedEntry = null;
    if (entries.length > 0) {
      selectEntry(entries[0]);
    } else {
      await createNewEntry();
    }
  }
  renderEntries();
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderEntries() {
  entriesList.innerHTML = '';
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'entry' + (selectedEntry && selectedEntry.filename === entry.filename ? ' selected' : '');

    const date = document.createElement('div');
    date.className = 'entry-date';
    date.textContent = entry.date;

    const preview = document.createElement('div');
    preview.className = 'entry-preview';
    preview.textContent = entry.previewText || 'Empty entry';

    const del = document.createElement('div');
    del.className = 'entry-delete';
    del.textContent = '×';
    del.title = 'Delete entry';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEntry(entry);
    });

    row.appendChild(date);
    row.appendChild(preview);
    row.appendChild(del);
    row.addEventListener('click', () => {
      selectEntry(entry);
      sidebar.hidden = true;
    });

    entriesList.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function applyFontSize(size) {
  fontSize = size;
  editor.style.fontSize = `${size}px`;
  fontSizeBtn.textContent = `${size}px`;
}

function cycleFontSize() {
  const idx = FONT_SIZES.indexOf(fontSize);
  applyFontSize(FONT_SIZES[(idx + 1) % FONT_SIZES.length]);
  saveSettings();
}

function applyFont(kind) {
  fontKind = kind;
  Object.values(fontButtons).forEach((b) => b.classList.remove('active'));
  fontButtons[kind].classList.add('active');

  if (kind === 'random') {
    editor.style.fontFamily = `'${randomFont}', serif`;
    fontButtons.random.textContent = `Random [${randomFont}]`;
  } else {
    editor.style.fontFamily = FONT_FAMILIES[kind];
    fontButtons.random.textContent = 'Random';
  }
}

function setFont(kind) {
  if (kind === 'random') {
    randomFont = RANDOM_FONTS[Math.floor(Math.random() * RANDOM_FONTS.length)];
  }
  applyFont(kind);
  saveSettings();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSettings();
}

// ---------------------------------------------------------------------------
// Timer (visual focus tool)
// ---------------------------------------------------------------------------

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimerLabel() {
  timerBtn.textContent = formatTime(timeRemaining);
}

function toggleTimer() {
  if (timerIsRunning) {
    clearInterval(timerInterval);
    timerIsRunning = false;
    document.body.classList.remove('timer-running');
    return;
  }
  timerIsRunning = true;
  document.body.classList.add('timer-running');
  timerInterval = setInterval(() => {
    timeRemaining = Math.max(0, timeRemaining - 1);
    updateTimerLabel();
    if (timeRemaining === 0) {
      clearInterval(timerInterval);
      timerIsRunning = false;
      document.body.classList.remove('timer-running'); // toolbar fades back in
    }
  }, 1000);
}

function resetTimer() {
  clearInterval(timerInterval);
  timerIsRunning = false;
  document.body.classList.remove('timer-running');
  timeRemaining = 900;
  updateTimerLabel();
}

// Scroll over the timer to adjust in 5-minute steps (rounded to nearest 5).
function adjustTimer(deltaY) {
  const step = deltaY < 0 ? 5 : -5; // scroll up = more time
  let minutes = Math.round(timeRemaining / 60 / 5) * 5 + step;
  minutes = Math.max(5, Math.min(120, minutes));
  timeRemaining = minutes * 60;
  updateTimerLabel();
}

// ---------------------------------------------------------------------------
// Backspace-disable toggle
// ---------------------------------------------------------------------------

function applyBackspaceState() {
  backspaceBtn.classList.toggle('active', backspaceDisabled);
  backspaceBtn.textContent = backspaceDisabled ? 'No Backspace' : 'Backspace';
}

function toggleBackspace() {
  backspaceDisabled = !backspaceDisabled;
  applyBackspaceState();
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showNotice._t);
  showNotice._t = setTimeout(() => {
    notice.hidden = true;
  }, 4000);
}

async function openChat(kind) {
  const text = editor.value.trim();
  const prompt = kind === 'claude' ? claudePrompt : aiChatPrompt;
  const fullText = prompt + '\n\n' + text;
  const encoded = encodeURIComponent(fullText);
  const url =
    kind === 'claude'
      ? 'https://claude.ai/new?q=' + encoded
      : 'https://chat.openai.com/?prompt=' + encoded;

  // Very long entries produce URLs browsers may reject — copy instead.
  if (url.length > MAX_URL_LENGTH) {
    await window.freewrite.copyToClipboard(fullText);
    showNotice(`Entry is long — prompt copied to clipboard. Paste it into ${kind === 'claude' ? 'Claude' : 'ChatGPT'}.`);
    return;
  }
  await window.freewrite.openExternal(url);
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

async function exportPdf() {
  if (!selectedEntry) return;
  const suggested = `freewrite-${selectedEntry.timestamp}.pdf`;
  const result = await window.freewrite.exportPdf(editor.value, suggested);
  if (result && result.ok) {
    showNotice('Saved PDF.');
  } else if (result && !result.canceled) {
    showNotice('Could not save PDF.');
  }
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

async function loadSettings() {
  settings = (await window.freewrite.getSettings()) || {};

  applyTheme(settings.theme === 'dark' ? 'dark' : 'light');

  fontSize = FONT_SIZES.includes(settings.fontSize) ? settings.fontSize : 18;
  applyFontSize(fontSize);

  if (settings.randomFont) randomFont = settings.randomFont;
  fontKind = settings.fontKind && (FONT_FAMILIES[settings.fontKind] || settings.fontKind === 'random')
    ? settings.fontKind
    : 'lato';
  applyFont(fontKind);
}

function saveSettings() {
  settings = {
    theme: document.documentElement.getAttribute('data-theme') || 'light',
    fontKind,
    fontSize,
    randomFont,
  };
  window.freewrite.setSettings(settings);
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

function closePopups() {
  fontSizePopup.hidden = true;
  chatPopup.hidden = true;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents() {
  // Editor: debounced auto-save + backspace interception.
  editor.addEventListener('input', scheduleSave);
  editor.addEventListener('blur', flushSave);
  editor.addEventListener('keydown', (e) => {
    if (backspaceDisabled && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  });

  // Font size: click opens the popup; each option applies a size.
  fontSizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chatPopup.hidden = true;
    fontSizePopup.hidden = !fontSizePopup.hidden;
  });
  document.querySelectorAll('.size-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      applyFontSize(parseInt(opt.dataset.size, 10));
      saveSettings();
      fontSizePopup.hidden = true;
    });
  });

  // Font family buttons.
  fontButtons.lato.addEventListener('click', () => setFont('lato'));
  fontButtons.system.addEventListener('click', () => setFont('system'));
  fontButtons.serif.addEventListener('click', () => setFont('serif'));
  fontButtons.mono.addEventListener('click', () => setFont('mono'));
  fontButtons.random.addEventListener('click', () => setFont('random'));

  // Timer: single click toggles (debounced so a double-click can reset),
  // double click resets, wheel adjusts.
  timerBtn.addEventListener('click', () => {
    if (timerClickTimer) return;
    timerClickTimer = setTimeout(() => {
      toggleTimer();
      timerClickTimer = null;
    }, 220);
  });
  timerBtn.addEventListener('dblclick', () => {
    if (timerClickTimer) {
      clearTimeout(timerClickTimer);
      timerClickTimer = null;
    }
    resetTimer();
  });
  timerBtn.addEventListener('wheel', (e) => {
    e.preventDefault();
    adjustTimer(e.deltaY);
  }, { passive: false });

  // Theme.
  themeBtn.addEventListener('click', toggleTheme);

  // Chat: toggle popup, then pick a provider.
  chatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fontSizePopup.hidden = true;
    chatPopup.hidden = !chatPopup.hidden;
  });
  document.getElementById('chatgpt-option').addEventListener('click', () => {
    chatPopup.hidden = true;
    openChat('chatgpt');
  });
  document.getElementById('claude-option').addEventListener('click', () => {
    chatPopup.hidden = true;
    openChat('claude');
  });

  // Backspace toggle, PDF, new entry, history.
  backspaceBtn.addEventListener('click', toggleBackspace);
  pdfBtn.addEventListener('click', exportPdf);
  newEntryBtn.addEventListener('click', createNewEntry);
  historyBtn.addEventListener('click', () => {
    sidebar.hidden = !sidebar.hidden;
  });
  closeSidebarBtn.addEventListener('click', () => {
    sidebar.hidden = true;
  });

  // Click anywhere else closes the open popups.
  document.addEventListener('click', (e) => {
    if (!fontSizePopup.contains(e.target) && e.target !== fontSizeBtn) fontSizePopup.hidden = true;
    if (!chatPopup.contains(e.target) && e.target !== chatBtn) chatPopup.hidden = true;
  });

  // Escape closes popups/sidebar, or quits the app if nothing is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!fontSizePopup.hidden || !chatPopup.hidden) {
      closePopups();
    } else if (!sidebar.hidden) {
      sidebar.hidden = true;
    } else {
      flushSave();
      window.close();
    }
  });

  // Best-effort save when the window is closing.
  window.addEventListener('beforeunload', flushSave);
}

window.addEventListener('DOMContentLoaded', init);
