/**
 * Enterprise CRM AI Copilot — Background Service Worker
 *
 * Proxies LLM requests to local or remote AI endpoints.
 * Supports AbortController (Stop button), Keep-Alive, thinking_budget_tokens,
 * max_tokens, temperature, and New York timezone context injection.
 */

const DEFAULT_SETTINGS = {
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

let activeAbortController = null;

async function getSettings() {
  const data = await chrome.storage.local.get('aiSettings');
  return { ...DEFAULT_SETTINGS, ...(data.aiSettings || {}) };
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ aiSettings: merged });
  return merged;
}

function normalizeApiUrl(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');

  if (url.startsWith('api.deepseek.com')) {
    url = `https://${url}`;
  }

  if (url.includes('api.deepseek.com')) {
    if (!url.includes('/chat/completions')) {
      return `${url}/chat/completions`;
    }
    return url;
  }

  if (url === 'http://localhost:11434' || url === 'http://127.0.0.1:11434') {
    return `${url}/v1/chat/completions`;
  }

  if (url.endsWith('/v1')) {
    return `${url}/chat/completions`;
  }

  if (!url.includes('/chat/completions') && !url.includes('/generate')) {
    return `${url}/chat/completions`;
  }

  return url;
}

function cleanApiKey(rawKey) {
  let key = (rawKey || '').trim();
  key = key.replace(/^Bearer\s+/i, '');
  key = key.replace(/^["'«»“”‘’`]|["'«»“”‘’`]$/g, '').trim();
  key = key.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n|\r/g, '');
  return key;
}

/**
 * Call OpenAI-compatible or Ollama chat completions endpoint
 */
async function callLlmApi(messages, customSettings = null, abortSignal = null) {
  const settings = customSettings || await getSettings();
  const url = normalizeApiUrl(settings.apiUrl);

  if (!url) {
    throw new Error('Не указан URL API. Заполните настройки.');
  }

  const headers = {
    'Content-Type': 'application/json'
  };

  const cleanKey = cleanApiKey(settings.apiKey);
  if (cleanKey) {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  let model = (settings.model || '').trim();
  if (url.includes('api.deepseek.com')) {
    if (!model || model === 'qwen2.5:latest') {
      model = 'deepseek-chat';
    }
  } else if (!model) {
    model = 'qwen2.5:latest';
  }

  const payload = {
    model,
    messages,
    stream: false
  };

  // DeepSeek-reasoner does NOT support temperature, top_p, etc.
  const isReasoner = model.toLowerCase().includes('reasoner');
  if (!isReasoner) {
    const tempVal = parseFloat(settings.temperature);
    payload.temperature = !isNaN(tempVal) ? tempVal : 0.7;
  }

  if (settings.max_tokens !== undefined && settings.max_tokens !== null && settings.max_tokens !== '') {
    const mt = parseInt(settings.max_tokens, 10);
    if (!isNaN(mt) && mt > 0) {
      payload.max_tokens = mt;
    }
  }

  // thinking_budget_tokens (only if not DeepSeek standard, which rejects this parameter)
  if (!url.includes('api.deepseek.com') && settings.thinking_budget_tokens) {
    const tbt = parseInt(settings.thinking_budget_tokens, 10);
    if (!isNaN(tbt) && tbt > 0) {
      payload.thinking_budget_tokens = tbt;
      payload.thinking = { type: 'enabled', budget_tokens: tbt };
    }
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 120000);

  const onAbort = () => timeoutController.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort);
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: timeoutController.signal
    });

    clearTimeout(timeoutId);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401) {
        if (url.includes('deepseek')) {
          let extra = '';
          try {
            const errJson = JSON.parse(errText);
            if (errJson.error && errJson.error.message) extra = `: ${errJson.error.message}`;
          } catch (e) {}
          throw new Error(`Ошибка 401 (Неверный API-ключ DeepSeek)${extra}.\nПроверьте: 1) Ключ должен быть с platform.deepseek.com и начинаться на "sk-". 2) Без кавычек и слова Bearer. 3) На аккаунте DeepSeek должен быть положительный баланс.`);
        }
        throw new Error(`API HTTP 401: Неверный API-ключ. Проверьте правильность ключа в настройках.`);
      }
      if (res.status === 402) {
        throw new Error(`API HTTP 402 (Insufficient Balance): На вашем аккаунте DeepSeek закончились средства. Пополните баланс на platform.deepseek.com.`);
      }
      throw new Error(`API HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const json = await res.json();

    let text = '';
    let reasoning = '';

    if (json.choices && json.choices[0]) {
      const choice = json.choices[0];
      if (choice.message) {
        text = choice.message.content || '';
        reasoning = choice.message.reasoning_content || choice.message.thought || '';
      } else if (choice.text) {
        text = choice.text;
      }
    } else if (json.message && json.message.content) {
      text = json.message.content;
    } else if (json.response) {
      text = json.response;
    }

    if (!text.trim() && reasoning.trim()) {
      text = reasoning.trim();
    }

    if (!text && typeof json === 'string') {
      text = json;
    }

    return text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

    if (err.name === 'AbortError') {
      if (abortSignal && abortSignal.aborted) {
        throw new Error('Генерация остановлена пользователем.');
      }
      throw new Error('Таймаут запроса к нейросети (120 сек).');
    }
    throw err;
  }
}

/**
 * Test connectivity
 */
async function testConnection(testSettings) {
  const settings = testSettings || await getSettings();
  const testMessages = [
    { role: 'user', content: 'Ответь одним словом: Работает' }
  ];

  const reply = await callLlmApi(testMessages, settings);
  return { success: true, reply: (reply || '').trim() };
}

/* ── Message Listener ─────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSettings') {
    getSettings().then(settings => sendResponse({ success: true, settings }));
    return true;
  }

  if (msg.action === 'saveSettings') {
    saveSettings(msg.settings).then(settings => sendResponse({ success: true, settings }));
    return true;
  }

  if (msg.action === 'testConnection') {
    testConnection(msg.settings)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'abortGeneration') {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'generateSuggestions') {
    const keepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 4000);

    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();

    (async () => {
      try {
        const settings = await getSettings();
        const systemPrompt = msg.systemPrompt || settings.systemPrompt;

        const nyTimeInfo = msg.currentNyDateTime || 'Нью-Йорк (США)';

        const contextLines = [
          `Текущая дата и время (строго Нью-Йорк, США): ${nyTimeInfo}`,
          `Клиент: ${msg.chatTitle || 'Клиент'}`,
          `Период: ${msg.communicationDay || 'День 1 общения с данным клиентом'}`,
          `Отправлено вложений менеджером за сегодня: ${msg.todayAttachments || '0/3'}`
        ].join('\n');

        const messages = [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `${contextLines}\n\nИстория диалога (время всех сообщений строго переведено в часовой пояс Нью-Йорка):\n${msg.chatHistoryText}\n\nВАЖНО: Обрати внимание на текущее время суток в Нью-Йорке (утро/день/вечер/ночь), день общения с клиентом и лимит вложений. Ответь строго на русском языке. Сразу начни с цифры 1 и напиши 3 готовых варианта ответа (без рассуждений на английском):`
          }
        ];

        const text = await callLlmApi(messages, settings, activeAbortController.signal);
        clearInterval(keepAlive);
        activeAbortController = null;
        sendResponse({ success: true, text });
      } catch (err) {
        clearInterval(keepAlive);
        activeAbortController = null;
        sendResponse({ success: false, error: err.message, aborted: err.message.includes('остановлена') });
      }
    })();
    return true;
  }
});
