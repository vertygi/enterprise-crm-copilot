/**
 * Enterprise CRM AI Copilot — Content Script
 *
 * Embeds natively into CRM layout shifting the active conversation pane.
 * Computes communication timeline, active session metadata, and attachment counts.
 * Synchronizes message timestamps to US Eastern Time (EDT/EST) for consistent scheduling.
 * Provides real-time context-aware response generation via local/serverless LLMs.
 */

(function () {
  'use strict';

  /* ── State ───────────────────────────────────────── */
  let isPaneOpen = false;
  let isGenerating = false;
  let activeTab = 'view-gen';
  let currentChatTitle = 'Не выбран';
  let currentChatText = '';
  let currentCommDay = 1;
  let currentTodayAttachments = 0;
  let currentStartDate = new Date();
  let currentStartDateStr = '';
  let isCurrentDatePinned = false;

  const pinnedDatesMap = new Map(); // chatKey -> ISO date string
  let currentChatHistList = []; // past generations for current chat

  let settings = {
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:latest',
    apiKey: '',
    temperature: 0.6,
    max_tokens: 300,
    thinking_budget_tokens: 100,
        systemPrompt: `# ROLE
You are an Enterprise CRM Copilot assisting account and support managers in handling customer communication.
You analyze incoming customer messages, ticket context, and interaction timelines to generate concise, professional, context-aware response options.

# GUIDELINES
- Provide clear, actionable, context-aware response variations ready to be sent.
- Maintain professional, empathetic tone matching enterprise communication standards.
- Respect customer timezone (EDT/EST) and historical context recorded in the CRM timeline.
- Never hallucinate policy details or commitments not verified in context.

# OUTPUT FORMAT
Generate 3 distinct ready-to-send options:
1. Direct concise response addressing the primary query.
2. Detailed response with follow-up information and clear next steps.
3. Professional relationship-building reply with proactive inquiry.`
  };

  const RU_MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];

  /* ── DOM Selectors ───────────────────────────────── */
  function getTwoPaneElement() {
    return document.querySelector('#two-pane, .two-pane');
  }

  function getThreadElement() {
    return document.querySelector('#thread, .thread');
  }

  function getChatTitle() {
    const waTitle = document.querySelector('#chat-title');
    if (waTitle && waTitle.textContent.trim()) {
      return waTitle.textContent.trim();
    }

    const tgTitle = document.querySelector('.ch-name');
    if (tgTitle && tgTitle.textContent.trim()) {
      return tgTitle.textContent.trim();
    }

    const activeRow = document.querySelector('.row.active .row-title, .row.active .title, #chat-list .row.active');
    if (activeRow && activeRow.textContent.trim()) {
      return activeRow.textContent.trim();
    }

    return 'Клиент';
  }

  function getChatStorageKey(title) {
    const normalized = (title || 'client').trim().toLowerCase().replace(/\s+/g, '_');
    return `gai_pdate_${normalized}`;
  }

  function getChatHistStorageKey(title) {
    const normalized = (title || 'client').trim().toLowerCase().replace(/\s+/g, '_');
    return `gai_ghist_${normalized}`;
  }

  /* ── New York Timezone & Date Helpers ────────────── */

  function getNewYorkNow() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU', {
      timeZone: 'America/New_York',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('ru-RU', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return {
      dateStr,
      timeStr,
      fullStr: `${dateStr}, ${timeStr}`
    };
  }

  /**
   * Convert local PC time (HH:MM) strictly to New York time (HH:MM)
   */
  function convertLocalTimeToNY(localTimeStr) {
    if (!localTimeStr) return '';
    const m = localTimeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return localTimeStr;

    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);

    const localDate = new Date();
    localDate.setHours(h, min, 0, 0);

    return localDate.toLocaleTimeString('ru-RU', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function formatRuDate(d) {
    return `${d.getDate()} ${RU_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function toDateInputValue(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getCalendarDayDiff(startDate, endDate) {
    const d1 = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const d2 = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const diffTime = d2.getTime() - d1.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }

  function parseRussianMonthWord(word) {
    if (!word) return -1;
    const w = word.toLowerCase();
    const roots = [
      'янв', 'фев', 'мар', 'апр', 'ма', 'июн',
      'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'
    ];
    for (let i = 0; i < roots.length; i++) {
      if (w.startsWith(roots[i])) return i;
    }
    return -1;
  }

  function parseDateFromText(text) {
    if (!text) return null;
    const str = text.toLowerCase().trim();
    const now = new Date();

    if (str === 'сегодня') return new Date();
    if (str === 'вчера') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    }

    const mWords = str.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/i);
    if (mWords) {
      const day = parseInt(mWords[1], 10);
      const month = parseRussianMonthWord(mWords[2]);
      if (month !== -1 && day >= 1 && day <= 31) {
        const year = mWords[3] ? parseInt(mWords[3], 10) : now.getFullYear();
        return new Date(year, month, day);
      }
    }

    const mDigits = str.match(/(?:^|\b)(\d{1,2})[\.\/\s-](\d{1,2})(?:[\.\/\s-](\d{2,4}))?\b/);
    if (mDigits) {
      const day = parseInt(mDigits[1], 10);
      const month = parseInt(mDigits[2], 10) - 1;
      let year = mDigits[3] ? parseInt(mDigits[3], 10) : now.getFullYear();
      if (year < 100) year += 2000;
      if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
        return new Date(year, month, day);
      }
    }

    return null;
  }

  function determineChatStartDate(title, thread) {
    const now = new Date();
    const key = getChatStorageKey(title);

    // 1. User pinned date
    if (pinnedDatesMap.has(key)) {
      const raw = pinnedDatesMap.get(key);
      const pinned = new Date(raw);
      if (!isNaN(pinned.getTime())) {
        return { date: pinned, isPinned: true };
      }
    }

    // 2. Client name prefix (e.g. "23 08 Victor...", "15.07 Герман...")
    const fromTitle = parseDateFromText(title);
    if (fromTitle) {
      return { date: fromTitle, isPinned: false };
    }

    // 3. Earliest day-sep in thread
    if (thread) {
      const daySeps = thread.querySelectorAll('.day-sep');
      for (const sep of daySeps) {
        const d = parseDateFromText(sep.textContent);
        if (d) return { date: d, isPinned: false };
      }
    }

    // 4. Fallback: today
    return { date: now, isPinned: false };
  }

  function isTodayDate(d) {
    if (!d) return false;
    const now = new Date();
    return d.getDate() === now.getDate() &&
           d.getMonth() === now.getMonth() &&
           d.getFullYear() === now.getFullYear();
  }

  /* ── Extract Clean Chat History & Compute Metrics ── */
  function extractChatHistory() {
    const thread = getThreadElement();
    if (!thread) {
      return { count: 0, text: 'Чат не выбран.', commDay: 1, todayAttachments: 0 };
    }

    const title = getChatTitle();
    currentChatTitle = title;

    const { date: startDate, isPinned } = determineChatStartDate(title, thread);
    currentStartDate = startDate;
    isCurrentDatePinned = isPinned;

    const now = new Date();
    const dayDiff = getCalendarDayDiff(startDate, now);
    const commDay = Math.max(1, dayDiff + 1);
    currentCommDay = commDay;
    currentStartDateStr = formatRuDate(startDate);

    const lines = [];
    let count = 0;
    let todayAttachments = 0;

    let isCurrentSectionToday = false;
    const daySeps = thread.querySelectorAll('.day-sep');

    if (daySeps.length === 0) {
      isCurrentSectionToday = true;
    }

    const children = Array.from(thread.children);

    for (const el of children) {
      if (el.classList.contains('day-sep')) {
        const dayText = el.textContent.trim();
        if (dayText) {
          lines.push(`--- ${dayText} ---`);
        }

        const sepDate = parseDateFromText(dayText);
        if (sepDate && isTodayDate(sepDate)) {
          isCurrentSectionToday = true;
        } else if (dayText.toLowerCase().includes('сегодня')) {
          isCurrentSectionToday = true;
        } else {
          isCurrentSectionToday = false;
        }
        continue;
      }

      if (el.classList.contains('msg')) {
        const isOut = el.classList.contains('out');
        let sender = isOut ? 'Вы' : title;
        const nameEl = el.querySelector('.msg-name');
        if (nameEl && nameEl.textContent.trim()) {
          sender = nameEl.textContent.trim();
        }

        let time = '';
        const tsEl = el.querySelector('.ts');
        if (tsEl) {
          const cloneTs = tsEl.cloneNode(true);
          cloneTs.querySelectorAll('svg, .tick, button').forEach(s => s.remove());
          time = cloneTs.textContent.trim();
        }

        let quoteText = '';
        const quoteEl = el.querySelector('.quote');
        if (quoteEl) {
          const qClone = quoteEl.cloneNode(true);
          qClone.querySelectorAll('.quote-icon').forEach(q => q.remove());
          quoteText = qClone.textContent.trim().replace(/\s+/g, ' ');
        }

        let content = '';

        // Attachment count from manager today
        const hasAttachment = el.querySelector('img.zoomable, .body img:not(.emoji), video, .doc, a[download]');
        if (isOut && hasAttachment) {
          if (isCurrentSectionToday || daySeps.length <= 1) {
            todayAttachments++;
          }
        }

        // Voice message
        const voiceContainer = el.querySelector('.aud, .voice');
        if (voiceContainer) {
          const transcript = el.querySelector('.gc-transcript.gc-done');
          if (transcript && transcript.textContent.trim()) {
            content = `[Голосовое: "${transcript.textContent.trim()}"]`;
          } else {
            content = '[Голосовое сообщение]';
          }
        }

        if (!content && hasAttachment) {
          content = '[Вложение / Изображение]';
        }

        if (!content && el.querySelector('.lottie-sticker, .sticker, img.sticker')) {
          content = '[Стикер]';
        }

        if (!content && el.querySelector('.del')) {
          content = '[Удалено]';
        }

        if (!content) {
          const bodyEl = el.querySelector('.body') || el.querySelector('.bubble');
          if (bodyEl) {
            const clone = bodyEl.cloneNode(true);
            clone.querySelectorAll('.ts, .msg-menu, .msg-menu-btn, .msg-name, .quote, .aud, .voice, .gc-transcript').forEach(n => n.remove());

            clone.querySelectorAll('img.emoji').forEach(img => {
              const alt = img.getAttribute('alt');
              if (alt) img.replaceWith(document.createTextNode(alt));
            });

            content = clone.textContent.trim().replace(/\s+/g, ' ');
          }
        }

        if (content) {
          count++;

          // Convert strictly to New York time (removing original PC time entirely)
          const nyTime = convertLocalTimeToNY(time);
          const finalTime = nyTime || time;

          let line = '';
          if (finalTime) line += `[${finalTime}] `;
          line += `${sender}: `;
          if (quoteText) line += `[В ответ на: "${quoteText}"] `;
          line += content;
          lines.push(line);
        }
      }
    }

    currentTodayAttachments = todayAttachments;
    currentChatText = lines.join('\n');

    return {
      count,
      text: currentChatText,
      commDay,
      todayAttachments
    };
  }

  /* ── Insert response text into CRM input ─────────── */
  function insertIntoCRM(text) {
    if (!text) return false;

    const waInput = document.querySelector('input#c-text, #c-text');
    if (waInput) {
      waInput.value = text;
      waInput.dispatchEvent(new Event('input', { bubbles: true }));
      waInput.dispatchEvent(new Event('change', { bubbles: true }));
      waInput.focus();
      showToast('Вставлено в поле ввода');
      return true;
    }

    const tgTextarea = document.querySelector('.composer textarea, textarea');
    if (tgTextarea) {
      tgTextarea.value = text;
      tgTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      tgTextarea.dispatchEvent(new Event('change', { bubbles: true }));
      tgTextarea.style.height = 'auto';
      tgTextarea.style.height = `${Math.min(tgTextarea.scrollHeight, 140)}px`;
      tgTextarea.focus();
      showToast('Вставлено в поле ввода');
      return true;
    }

    navigator.clipboard.writeText(text);
    showToast('Скопировано в буфер');
    return true;
  }

  /* ── Toast notification ──────────────────────────── */
  function showToast(message) {
    let toast = document.getElementById('gai-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gai-toast';
      toast.className = 'gai-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('gai-show');
    setTimeout(() => toast.classList.remove('gai-show'), 2000);
  }

  /* ── Mount / Inject UI into CRM Layout ───────────── */
  function ensureElementsInDOM() {
    let toggleBtn = document.getElementById('gai-toggle-btn');
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.id = 'gai-toggle-btn';
      toggleBtn.textContent = 'AI';
      toggleBtn.title = 'AI Помощник (Alt + A)';
      toggleBtn.addEventListener('click', togglePane);
      document.body.appendChild(toggleBtn);
    }

    let pane = document.getElementById('gai-pane');
    if (!pane) {
      pane = document.createElement('aside');
      pane.id = 'gai-pane';
      pane.className = 'gai-pane gai-closed';
      pane.innerHTML = `
        <div class="gai-header">
          <span class="gai-title">AI</span>
          <span class="gai-contact-tag" id="gai-chat-tag">Клиент</span>
          <button class="gai-btn-close" id="gai-close-btn" title="Скрыть панель">✕</button>
        </div>

        <div class="gai-tabs">
          <button class="gai-tab active" data-tab="view-gen">Генерация</button>
          <button class="gai-tab" data-tab="view-hist">История</button>
          <button class="gai-tab" data-tab="view-cfg">Настройки</button>
        </div>

        <div class="gai-body">
          <!-- Tab 1: Generation -->
          <div class="gai-tab-view active" id="view-gen">
            <!-- Client, Day & Attachments Info Card -->
            <div class="gai-info-card">
              <div class="gai-info-row">
                <div class="gai-info-col" style="flex:1.4;">
                  <span class="gai-info-label">Клиент</span>
                  <span class="gai-info-val" id="gai-card-client">Не выбран</span>
                </div>
                <div class="gai-info-col">
                  <span class="gai-info-label">День общения</span>
                  <span class="gai-info-val gai-highlight" id="gai-card-day">День 1</span>
                </div>
                <div class="gai-info-col">
                  <span class="gai-info-label">Вложения сегодня</span>
                  <span class="gai-info-val gai-badge-pill" id="gai-card-attach">0/3</span>
                </div>
              </div>
              <div class="gai-info-sub">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:4px;">
                  <span id="gai-card-date">Сегодня: ...</span>
                  <button class="gai-pencil-btn" id="gai-edit-date-btn" title="Изменить дату начала общения">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                </div>
                <div id="gai-date-picker-wrap" style="display:none; align-items:center; gap:6px; margin-top:6px;">
                  <input type="date" id="gai-custom-date-input" class="gai-input" style="padding:2px 5px; font-size:11px; flex:1;">
                  <button class="gai-btn-action" id="gai-save-custom-date" style="padding:3px 7px; font-size:10px;">OK</button>
                  <button class="gai-btn-action" id="gai-reset-custom-date" style="padding:3px 7px; font-size:10px; color:var(--gai-text-muted);" title="Вернуть автоматическое определение даты">Авто</button>
                </div>
              </div>
            </div>

            <!-- Collapsible System Prompt -->
            <details class="gai-prompt-details" id="gai-prompt-details">
              <summary class="gai-prompt-summary">Системный промпт</summary>
              <textarea class="gai-textarea" id="gai-prompt-input" rows="3" placeholder="Инструкция для нейросети..."></textarea>
              <div style="display:flex; justify-content:flex-end; margin-top:4px;">
                <button class="gai-btn-action" id="gai-reset-prompt" style="font-size:10px; padding:2px 6px;">Сброс</button>
              </div>
            </details>

            <div class="gai-gen-btn-row">
              <button class="gai-btn-submit" id="gai-btn-generate">
                <span id="gai-btn-label">Сгенерировать</span>
              </button>
              <button class="gai-btn-stop" id="gai-btn-stop" title="Остановить генерацию">
                Стоп
              </button>
            </div>

            <div id="gai-results-box" style="display:flex; flex-direction:column; gap:8px;"></div>

            <!-- Collapsible Past Generations History -->
            <details class="gai-history-details" id="gai-gen-history-details">
              <summary class="gai-history-summary">
                <span id="gai-hist-summary-title">История генераций (0)</span>
              </summary>
              <div style="display:flex; justify-content:flex-end; margin-top:4px;">
                <button class="gai-btn-action" id="gai-clear-gen-hist" style="font-size:10px; padding:2px 6px;">Очистить</button>
              </div>
              <div class="gai-gen-hist-list" id="gai-gen-hist-list">
                <div style="font-size:11px; color:var(--gai-text-muted); text-align:center; padding:8px;">
                  Нет сохранённых генераций для этого чата
                </div>
              </div>
            </details>
          </div>

          <!-- Tab 2: History -->
          <div class="gai-tab-view" id="view-hist">
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px; color:var(--gai-text-muted);">
              <span id="gai-msg-count">Сообщений: 0</span>
              <button class="gai-btn-action" id="gai-copy-all">Копировать всё</button>
            </div>
            <pre class="gai-history-pre" id="gai-history-text">Загрузка...</pre>
          </div>

          <!-- Tab 3: Settings -->
          <div class="gai-tab-view" id="view-cfg">
            <div class="gai-box">
              <div class="gai-field-row" style="margin-bottom:4px;">
                <span class="gai-label">Быстрые пресеты</span>
                <div style="display:flex; gap:4px;">
                  <button type="button" class="gai-btn-action" id="gai-preset-deepseek-v3" style="flex:1; font-size:10px; padding:3px 4px; background:var(--gai-primary-subtle); color:var(--gai-primary);">DeepSeek V3</button>
                  <button type="button" class="gai-btn-action" id="gai-preset-deepseek-r1" style="flex:1; font-size:10px; padding:3px 4px;">DeepSeek R1</button>
                  <button type="button" class="gai-btn-action" id="gai-preset-local" style="flex:1; font-size:10px; padding:3px 4px;">Локальный</button>
                </div>
              </div>

              <div class="gai-field-row">
                <span class="gai-label">URL API</span>
                <input class="gai-input" id="gai-cfg-url" placeholder="https://api.deepseek.com/chat/completions">
              </div>

              <div class="gai-field-row">
                <span class="gai-label">Модель</span>
                <input class="gai-input" id="gai-cfg-model" placeholder="deepseek-chat, deepseek-reasoner...">
              </div>

              <div class="gai-field-row">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="gai-label">API-ключ</span>
                  <span style="font-size:10px; color:var(--gai-text-muted);">platform.deepseek.com</span>
                </div>
                <input class="gai-input" id="gai-cfg-key" type="password" placeholder="sk-...">
              </div>

              <div class="gai-field-row">
                <span class="gai-label">temperature</span>
                <input class="gai-input" id="gai-cfg-temp" type="number" step="0.05" min="0" max="2" value="0.7">
              </div>

              <div class="gai-field-row">
                <span class="gai-label">max_tokens</span>
                <input class="gai-input" id="gai-cfg-maxtokens" type="number" step="128" min="0" placeholder="4096">
              </div>

              <div class="gai-field-row">
                <span class="gai-label">thinking_budget_tokens</span>
                <input class="gai-input" id="gai-cfg-thinking" type="number" step="128" min="0" placeholder="0 (выключено)">
              </div>

              <div style="display:flex; gap:6px; margin-top:4px;">
                <button class="gai-btn-submit" id="gai-save-cfg" style="flex:1; padding:7px;">Сохранить</button>
                <button class="gai-btn-action" id="gai-test-cfg" style="flex:1; padding:7px;">Проверить связь</button>
              </div>

              <div id="gai-status-box" style="display:none; font-size:11.5px; padding:6px 8px; border-radius:4px; line-height:1.4;"></div>
            </div>
          </div>
        </div>
      `;

      setupEvents(pane);
    }

    const twoPane = getTwoPaneElement();
    if (twoPane && pane.parentElement !== twoPane) {
      twoPane.appendChild(pane);
      pane.classList.remove('gai-fixed-fallback');
    } else if (!twoPane && pane.parentElement !== document.body) {
      document.body.appendChild(pane);
      pane.classList.add('gai-fixed-fallback');
    }
  }

  /* ── Event Handlers ──────────────────────────────── */
  function setupEvents(pane) {
    pane.querySelector('#gai-close-btn')?.addEventListener('click', closePane);

    pane.querySelectorAll('.gai-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        const target = tabBtn.dataset.tab;
        switchTab(target);
      });
    });

    pane.querySelector('#gai-reset-prompt')?.addEventListener('click', () => {
      const input = document.getElementById('gai-prompt-input');
      if (input) {
        input.value = settings.systemPrompt;
        showToast('Промпт сброшен');
      }
    });

    // Pencil Date Edit Handlers
    const editDateBtn = pane.querySelector('#gai-edit-date-btn');
    const datePickerWrap = pane.querySelector('#gai-date-picker-wrap');
    const dateInput = pane.querySelector('#gai-custom-date-input');
    const saveDateBtn = pane.querySelector('#gai-save-custom-date');
    const resetDateBtn = pane.querySelector('#gai-reset-custom-date');

    editDateBtn?.addEventListener('click', () => {
      if (!datePickerWrap) return;
      const isVisible = datePickerWrap.style.display === 'flex';
      datePickerWrap.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible && dateInput) {
        dateInput.value = toDateInputValue(currentStartDate);
        dateInput.focus();
      }
    });

    saveDateBtn?.addEventListener('click', async () => {
      if (!dateInput || !dateInput.value) return;
      const parsed = new Date(dateInput.value);
      if (isNaN(parsed.getTime())) {
        showToast('Неверная дата');
        return;
      }
      const key = getChatStorageKey(currentChatTitle);
      pinnedDatesMap.set(key, parsed.toISOString());
      await chrome.storage.local.set({ [key]: parsed.toISOString() });

      datePickerWrap.style.display = 'none';
      await syncChatData();
      showToast(`Дата закреплена (День ${currentCommDay})`);
    });

    resetDateBtn?.addEventListener('click', async () => {
      const key = getChatStorageKey(currentChatTitle);
      pinnedDatesMap.delete(key);
      await chrome.storage.local.remove(key);

      datePickerWrap.style.display = 'none';
      await syncChatData();
      showToast('Автоопределение даты возвращено');
    });

    // Clear generations history
    pane.querySelector('#gai-clear-gen-hist')?.addEventListener('click', async () => {
      currentChatHistList = [];
      const key = getChatHistStorageKey(currentChatTitle);
      await chrome.storage.local.remove(key);
      renderPastGenerations();
      showToast('История генераций очищена');
    });

    // Generate & Stop
    pane.querySelector('#gai-btn-generate')?.addEventListener('click', handleGenerate);
    pane.querySelector('#gai-btn-stop')?.addEventListener('click', handleStop);

    // Copy all history
    pane.querySelector('#gai-copy-all')?.addEventListener('click', () => {
      if (!currentChatText) syncChatData();
      navigator.clipboard.writeText(currentChatText);
      showToast('Скопировано в буфер');
    });

    // Preset buttons
    pane.querySelector('#gai-preset-deepseek-v3')?.addEventListener('click', () => {
      const urlInput = document.getElementById('gai-cfg-url');
      const modelInput = document.getElementById('gai-cfg-model');
      const tempInput = document.getElementById('gai-cfg-temp');
      const maxInput = document.getElementById('gai-cfg-maxtokens');
      const thinkInput = document.getElementById('gai-cfg-thinking');
      const keyInput = document.getElementById('gai-cfg-key');

      if (urlInput) urlInput.value = 'https://api.deepseek.com/chat/completions';
      if (modelInput) modelInput.value = 'deepseek-chat';
      if (tempInput) tempInput.value = '0.7';
      if (maxInput) maxInput.value = '4096';
      if (thinkInput) thinkInput.value = '0';
      keyInput?.focus();
      showToast('Выбран DeepSeek V3');
    });

    pane.querySelector('#gai-preset-deepseek-r1')?.addEventListener('click', () => {
      const urlInput = document.getElementById('gai-cfg-url');
      const modelInput = document.getElementById('gai-cfg-model');
      const maxInput = document.getElementById('gai-cfg-maxtokens');
      const thinkInput = document.getElementById('gai-cfg-thinking');
      const keyInput = document.getElementById('gai-cfg-key');

      if (urlInput) urlInput.value = 'https://api.deepseek.com/chat/completions';
      if (modelInput) modelInput.value = 'deepseek-reasoner';
      if (maxInput) maxInput.value = '4096';
      if (thinkInput) thinkInput.value = '0';
      keyInput?.focus();
      showToast('Выбран DeepSeek R1');
    });

    pane.querySelector('#gai-preset-local')?.addEventListener('click', () => {
      const urlInput = document.getElementById('gai-cfg-url');
      const modelInput = document.getElementById('gai-cfg-model');
      const tempInput = document.getElementById('gai-cfg-temp');
      const maxInput = document.getElementById('gai-cfg-maxtokens');
      const thinkInput = document.getElementById('gai-cfg-thinking');

      if (urlInput) urlInput.value = 'http://localhost:11434/v1/chat/completions';
      if (modelInput) modelInput.value = 'qwen2.5:latest';
      if (tempInput) tempInput.value = '0.7';
      if (maxInput) maxInput.value = '2048';
      if (thinkInput) thinkInput.value = '0';
      showToast('Выбран локальный Ollama');
    });

    // Save settings
    pane.querySelector('#gai-save-cfg')?.addEventListener('click', saveConfig);

    // Test settings
    pane.querySelector('#gai-test-cfg')?.addEventListener('click', testConfig);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isPaneOpen) {
        closePane();
      }
      if (e.altKey && (e.key === 'a' || e.key === 'A' || e.key === 'ф' || e.key === 'Ф')) {
        togglePane();
      }
    });
  }

  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.gai-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.gai-tab-view').forEach(v => {
      v.classList.toggle('active', v.id === tabId);
    });

    if (tabId === 'view-hist') {
      syncChatData();
    }
  }

  function togglePane() {
    if (isPaneOpen) closePane();
    else openPane();
  }

  function openPane() {
    ensureElementsInDOM();
    isPaneOpen = true;
    const pane = document.getElementById('gai-pane');
    const toggleBtn = document.getElementById('gai-toggle-btn');
    if (pane) pane.classList.remove('gai-closed');
    if (toggleBtn) toggleBtn.classList.add('gai-hidden');
    syncChatData();
  }

  function closePane() {
    isPaneOpen = false;
    const pane = document.getElementById('gai-pane');
    const toggleBtn = document.getElementById('gai-toggle-btn');
    if (pane) pane.classList.add('gai-closed');
    if (toggleBtn) toggleBtn.classList.remove('gai-hidden');
  }

  /* ── Sync Chat Data ──────────────────────────────── */
  async function syncChatData() {
    const { count, text, commDay, todayAttachments } = extractChatHistory();

    const tag = document.getElementById('gai-chat-tag');
    if (tag) tag.textContent = currentChatTitle;

    const cardClient = document.getElementById('gai-card-client');
    if (cardClient) cardClient.textContent = currentChatTitle;

    const cardDay = document.getElementById('gai-card-day');
    if (cardDay) cardDay.textContent = `День ${commDay}`;

    const cardAttach = document.getElementById('gai-card-attach');
    if (cardAttach) cardAttach.textContent = `${todayAttachments}/3`;

    const cardDate = document.getElementById('gai-card-date');
    const editBtn = document.getElementById('gai-edit-date-btn');
    if (cardDate) {
      const ny = getNewYorkNow();
      const pinnedSuffix = isCurrentDatePinned ? ' (закреплено)' : '';
      cardDate.textContent = `Сейчас (NY): ${ny.timeStr} · Чат: ${currentStartDateStr}${pinnedSuffix}`;
    }

    if (editBtn) {
      editBtn.classList.toggle('gai-pinned', isCurrentDatePinned);
      editBtn.title = isCurrentDatePinned ? 'Дата закреплена вручную (кликните для изменения)' : 'Изменить дату начала общения';
    }

    const hist = document.getElementById('gai-history-text');
    if (hist) hist.textContent = text || 'История чата пуста.';

    const counter = document.getElementById('gai-msg-count');
    if (counter) counter.textContent = `Сообщений: ${count}`;

    await loadPastGenerations();
  }

  /* ── Past Generations History Management ─────────── */
  async function loadPastGenerations() {
    const key = getChatHistStorageKey(currentChatTitle);
    try {
      const data = await chrome.storage.local.get(key);
      currentChatHistList = data[key] || [];
    } catch (e) {
      currentChatHistList = [];
    }
    renderPastGenerations();
  }

  async function saveNewGeneration(variants) {
    if (!variants || !variants.length) return;
    const ny = getNewYorkNow();

    const item = {
      id: Date.now(),
      timeNY: ny.timeStr,
      dateNY: ny.dateStr,
      variants: variants.map(v => ({ num: v.num, text: v.text }))
    };

    currentChatHistList.unshift(item);
    if (currentChatHistList.length > 20) {
      currentChatHistList = currentChatHistList.slice(0, 20);
    }

    const key = getChatHistStorageKey(currentChatTitle);
    await chrome.storage.local.set({ [key]: currentChatHistList });
    renderPastGenerations();
  }

  function renderPastGenerations() {
    const titleEl = document.getElementById('gai-hist-summary-title');
    const listEl = document.getElementById('gai-gen-hist-list');
    if (!listEl) return;

    const count = currentChatHistList.length;
    if (titleEl) titleEl.textContent = `История генераций (${count})`;

    if (count === 0) {
      listEl.innerHTML = `
        <div style="font-size:11px; color:var(--gai-text-muted); text-align:center; padding:8px;">
          Нет сохранённых генераций для этого чата
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    currentChatHistList.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'gai-gen-hist-item';

      let variantsHtml = '';
      (item.variants || []).forEach(v => {
        variantsHtml += `
          <div style="margin-top:4px; padding-top:4px; border-top:1px dashed var(--gai-border);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-weight:700; color:var(--gai-primary); font-size:10.5px;">Вариант ${v.num}</span>
              <div style="display:flex; gap:4px;">
                <button class="gai-btn-action gai-hist-copy" style="font-size:9.5px; padding:1px 5px;">Копия</button>
                <button class="gai-btn-action gai-hist-insert" style="font-size:9.5px; padding:1px 5px; background:var(--gai-primary); color:#fff;">Вставить</button>
              </div>
            </div>
            <div class="gai-gen-hist-content">${v.text}</div>
          </div>
        `;
      });

      div.innerHTML = `
        <div class="gai-gen-hist-meta">
          <span style="font-weight:600;">Генерация #${count - idx}</span>
          <span>${item.dateNY || ''} в ${item.timeNY || ''} (NY)</span>
        </div>
        ${variantsHtml}
      `;

      const copyBtns = div.querySelectorAll('.gai-hist-copy');
      const insertBtns = div.querySelectorAll('.gai-hist-insert');

      (item.variants || []).forEach((v, vIdx) => {
        copyBtns[vIdx]?.addEventListener('click', () => {
          navigator.clipboard.writeText(v.text);
          showToast('Скопировано');
        });

        insertBtns[vIdx]?.addEventListener('click', () => {
          insertIntoCRM(v.text);
        });
      });

      listEl.appendChild(div);
    });
  }

  /* ── Parse Model Response ────────────────────────── */
  function parseSuggestions(rawText) {
    if (!rawText || !rawText.trim()) return [];

    let cleaned = rawText.trim();

    // 1. Strip closed <think>...</think> block
    if (cleaned.includes('</think>')) {
      const parts = cleaned.split('</think>');
      const afterThink = parts[1]?.trim();
      if (afterThink) {
        cleaned = afterThink;
      }
    } else if (cleaned.startsWith('<think>')) {
      cleaned = cleaned.replace(/^<think>\s*/i, '').trim();
    }

    // 2. If model wrote preamble thoughts before "1.", find where 1. starts
    const firstNumberedIndex = cleaned.search(/(?:^|\n)\s*(?:1[\.\)]|Вариант\s*1)/i);
    if (firstNumberedIndex > 0) {
      cleaned = cleaned.slice(firstNumberedIndex).trim();
    }

    const lines = cleaned.split('\n');
    const variants = [];
    let cur = null;

    for (const line of lines) {
      const match = line.match(/^(\d+)[\.\)]\s*(.*)$/) || line.match(/^(?:Вариант\s*(\d+)[:\.]?)\s*(.*)$/i);
      if (match) {
        if (cur) variants.push(cur);
        cur = { num: match[1], text: match[2] || '' };
      } else if (cur) {
        if (cur.text) cur.text += '\n';
        cur.text += line;
      }
    }
    if (cur) variants.push(cur);

    if (!variants.length && cleaned) {
      const isPureEnglishThinking = /^(?:we need|i should|i need|let me|the user|first,|analyzing)/i.test(cleaned);
      if (isPureEnglishThinking) {
        return [{
          isThinkingWarning: true,
          num: '1',
          text: cleaned
        }];
      }
      return [{ num: '1', text: cleaned }];
    }

    return variants;
  }

  /* ── Stop Generation ─────────────────────────────── */
  function handleStop() {
    if (!isGenerating) return;

    try {
      chrome.runtime.sendMessage({ action: 'abortGeneration' });
    } catch (e) {}

    isGenerating = false;
    resetGenButtons();

    const resultsBox = document.getElementById('gai-results-box');
    if (resultsBox && resultsBox.querySelector('.gai-spinner')) {
      resultsBox.innerHTML = `
        <div class="gai-box" style="color:var(--gai-text-muted); font-size:12px; text-align:center;">
          Генерация остановлена.
        </div>
      `;
    }
    showToast('Генерация остановлена');
  }

  function resetGenButtons() {
    const btn = document.getElementById('gai-btn-generate');
    const label = document.getElementById('gai-btn-label');
    const stopBtn = document.getElementById('gai-btn-stop');

    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Сгенерировать';
    if (stopBtn) stopBtn.classList.remove('gai-active');
  }

  /* ── Generate Action ─────────────────────────────── */
  async function handleGenerate() {
    await syncChatData();

    if (!currentChatText || currentChatText.length < 5) {
      showToast('Чат не выбран или пуст');
      return;
    }

    const btn = document.getElementById('gai-btn-generate');
    const label = document.getElementById('gai-btn-label');
    const stopBtn = document.getElementById('gai-btn-stop');
    const resultsBox = document.getElementById('gai-results-box');
    const promptInput = document.getElementById('gai-prompt-input');

    const promptVal = promptInput ? promptInput.value.trim() : '';

    isGenerating = true;
    if (btn) btn.disabled = true;
    if (label) label.innerHTML = '<span class="gai-spinner"></span> Генерация...';
    if (stopBtn) stopBtn.classList.add('gai-active');

    resultsBox.innerHTML = `
      <div class="gai-box" style="text-align:center; padding:16px; color:var(--gai-text-muted); font-size:12px;">
        <span class="gai-spinner" style="border-top-color:var(--gai-primary); border-color:var(--gai-border); margin-bottom:6px;"></span>
        <div>Генерация ответа нейросетью...</div>
      </div>
    `;

    try {
      const ny = getNewYorkNow();

      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'generateSuggestions',
          chatTitle: currentChatTitle,
          currentNyDateTime: ny.fullStr,
          communicationDay: `День ${currentCommDay} общения с данным клиентом`,
          todayAttachments: `${currentTodayAttachments}/3`,
          chatHistoryText: currentChatText,
          systemPrompt: promptVal || settings.systemPrompt
        }, (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(response);
        });
      });

      if (!isGenerating) return;

      if (!res || !res.success) {
        if (res?.aborted) {
          handleStop();
          return;
        }
        throw new Error(res?.error || 'Ошибка вызова API');
      }

      const raw = res.text || '';
      const variants = parseSuggestions(raw);

      if (!variants.length) {
        resultsBox.innerHTML = `
          <div class="gai-box" style="background:var(--gai-surface); border-color:var(--gai-border);">
            <span style="font-weight:700; font-size:11.5px; color:var(--gai-text);">Ответ не получен</span>
            <div style="font-size:12px; line-height:1.4; color:var(--gai-text-muted); margin-top:4px;">
              Модель вернула пустой результат. Если используется thinking/reasoning модель, лимит токенов (max_tokens: ${settings.max_tokens}) мог закончиться на стадии рассуждений. Увеличьте max_tokens в Настройках (например, до 1500–2048).
            </div>
          </div>
        `;
      } else {
        renderVariants(variants);
        if (!variants[0].isThinkingWarning) {
          await saveNewGeneration(variants);
        }
      }
    } catch (err) {
      if (!isGenerating) return;

      let msg = err.message || 'Ошибка соединения';
      if (msg.includes('Extension context invalidated')) {
        msg = 'Плагин был обновлен в браузере. Обновите страницу CRM (F5).';
      } else if (msg.includes('message channel closed')) {
        msg = 'Связь с расширением прервалась во время генерации. Нажмите Сгенерировать снова.';
      }

      resultsBox.innerHTML = `
        <div class="gai-box" style="background:var(--gai-error-bg); border-color:var(--gai-error);">
          <span style="font-weight:700; color:var(--gai-error); font-size:11.5px;">Ошибка генерации</span>
          <div style="font-size:12px; line-height:1.4;">${msg}</div>
        </div>
      `;
    } finally {
      isGenerating = false;
      resetGenButtons();
    }
  }

  function renderVariants(variants) {
    const box = document.getElementById('gai-results-box');
    if (!box) return;

    box.innerHTML = '';

    if (variants.length === 1 && variants[0].isThinkingWarning) {
      box.innerHTML = `
        <div class="gai-box" style="border-left:3px solid var(--gai-primary); background:var(--gai-surface);">
          <span style="font-weight:700; font-size:11.5px; color:var(--gai-text);">Лимит токенов исчерпан на рассуждениях</span>
          <div style="font-size:11.5px; color:var(--gai-text-muted); line-height:1.4; margin-top:3px;">
            Модель потратила токены на рассуждения на английском языке (${variants[0].text.length} симв.) и не успела вывести ответы на русском. Увеличьте <b>max_tokens</b> в Настройках до 1000–2048.
          </div>
          <pre style="margin-top:6px; font-size:11px; max-height:100px; overflow:auto; background:var(--gai-bg); padding:6px; border-radius:4px; border:1px solid var(--gai-border); white-space:pre-wrap;">${variants[0].text}</pre>
        </div>
      `;
      return;
    }

    variants.forEach((v, idx) => {
      const card = document.createElement('div');
      card.className = 'gai-variant-card';
      card.innerHTML = `
        <div class="gai-variant-head">
          <span>Вариант ${v.num || idx + 1}</span>
        </div>
        <div class="gai-variant-body">${v.text.trim()}</div>
        <div class="gai-variant-foot">
          <button class="gai-btn-action gai-act-copy">Копировать</button>
          <button class="gai-btn-action gai-act-insert" style="background:var(--gai-primary); color:#fff; border-color:var(--gai-primary);">Вставить</button>
        </div>
      `;

      card.querySelector('.gai-act-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(v.text.trim());
        showToast('Скопировано');
      });

      card.querySelector('.gai-act-insert').addEventListener('click', () => {
        insertIntoCRM(v.text.trim());
      });

      box.appendChild(card);
    });
  }

  function cleanApiKey(rawKey) {
    let key = (rawKey || '').trim();
    key = key.replace(/^Bearer\s+/i, '');
    key = key.replace(/^["'«»“”‘’`]|["'«»“”‘’`]$/g, '').trim();
    key = key.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n|\r/g, '');
    return key;
  }

  /* ── Settings Save & Test ────────────────────────── */
  async function saveConfig() {
    const url = document.getElementById('gai-cfg-url')?.value.trim();
    const model = document.getElementById('gai-cfg-model')?.value.trim();
    const rawKey = document.getElementById('gai-cfg-key')?.value.trim();
    const key = cleanApiKey(rawKey);
    const keyInput = document.getElementById('gai-cfg-key');
    if (keyInput && rawKey !== key) keyInput.value = key;

    const temp = parseFloat(document.getElementById('gai-cfg-temp')?.value);
    const maxTok = document.getElementById('gai-cfg-maxtokens')?.value.trim();
    const think = document.getElementById('gai-cfg-thinking')?.value.trim();

    settings.apiUrl = url || settings.apiUrl;
    settings.model = model || settings.model;
    settings.apiKey = key;
    settings.temperature = !isNaN(temp) ? temp : 0.7;
    settings.max_tokens = maxTok !== '' ? parseInt(maxTok, 10) : 2048;
    settings.thinking_budget_tokens = think !== '' ? parseInt(think, 10) : 0;

    await chrome.runtime.sendMessage({
      action: 'saveSettings',
      settings
    });

    showToast('Настройки сохранены');
  }

  async function testConfig() {
    const box = document.getElementById('gai-status-box');
    if (box) {
      box.style.display = 'block';
      box.style.background = 'var(--gai-surface)';
      box.style.color = 'var(--gai-text-muted)';
      box.textContent = 'Проверка соединения...';
    }

    const url = document.getElementById('gai-cfg-url')?.value.trim() || settings.apiUrl;
    const model = document.getElementById('gai-cfg-model')?.value.trim() || settings.model;
    const rawKey = document.getElementById('gai-cfg-key')?.value.trim() || settings.apiKey;
    const key = cleanApiKey(rawKey);
    const temp = parseFloat(document.getElementById('gai-cfg-temp')?.value);
    const maxTok = document.getElementById('gai-cfg-maxtokens')?.value.trim();
    const think = document.getElementById('gai-cfg-thinking')?.value.trim();

    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'testConnection',
        settings: {
          apiUrl: url,
          model,
          apiKey: key,
          temperature: !isNaN(temp) ? temp : 0.7,
          max_tokens: maxTok !== '' ? parseInt(maxTok, 10) : 2048,
          thinking_budget_tokens: think !== '' ? parseInt(think, 10) : 0
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          return resolve({ success: false, error: chrome.runtime.lastError.message });
        }
        resolve(response || { success: false, error: 'Нет ответа' });
      });
    });

    if (box) {
      if (res.success) {
        box.style.background = 'rgba(16, 185, 129, 0.15)';
        box.style.color = 'var(--gai-success)';
        box.textContent = `Связь установлена (${res.reply})`;
      } else {
        box.style.background = 'var(--gai-error-bg)';
        box.style.color = 'var(--gai-error)';
        box.textContent = `Ошибка: ${res.error}`;
      }
    }
  }

  async function preloadPinnedDates() {
    try {
      const all = await chrome.storage.local.get(null);
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith('gai_pdate_') && typeof v === 'string') {
          pinnedDatesMap.set(k, v);
        }
      }
    } catch (e) {}
  }

  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getSettings' });
      if (res && res.settings) {
        settings = { ...settings, ...res.settings };
      }
    } catch (e) {}

    const urlEl = document.getElementById('gai-cfg-url');
    const modelEl = document.getElementById('gai-cfg-model');
    const keyEl = document.getElementById('gai-cfg-key');
    const tempEl = document.getElementById('gai-cfg-temp');
    const maxEl = document.getElementById('gai-cfg-maxtokens');
    const thinkEl = document.getElementById('gai-cfg-thinking');
    const promptEl = document.getElementById('gai-prompt-input');

    if (urlEl) urlEl.value = settings.apiUrl || '';
    if (modelEl) modelEl.value = settings.model || '';
    if (keyEl) keyEl.value = settings.apiKey || '';
    if (tempEl) tempEl.value = settings.temperature ?? 0.7;
    if (maxEl) maxEl.value = settings.max_tokens ?? 2048;
    if (thinkEl) thinkEl.value = settings.thinking_budget_tokens ?? 0;
    if (promptEl) promptEl.value = settings.systemPrompt || '';
  }

  /* ── Dynamic Observer for SPA Navigation ─────────── */
  function startObservers() {
    const anchor = document.querySelector('#pane-chat, .pane-chat') || document.body;
    let lastChat = getChatTitle();

    const observer = new MutationObserver(() => {
      ensureElementsInDOM();

      const current = getChatTitle();
      if (current !== lastChat) {
        lastChat = current;
        syncChatData();
      }
    });

    observer.observe(anchor, { childList: true, subtree: true });

    document.addEventListener('click', (e) => {
      const row = e.target.closest('.row, [data-chat]');
      if (row) {
        setTimeout(syncChatData, 200);
        setTimeout(syncChatData, 600);
      }
    });

    setInterval(() => {
      if (isPaneOpen) syncChatData();
    }, 2500);
  }

  /* ── Init ────────────────────────────────────────── */
  async function init() {
    await preloadPinnedDates();
    ensureElementsInDOM();
    await loadSettings();
    await syncChatData();
    startObservers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
