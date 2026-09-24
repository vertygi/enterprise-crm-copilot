/**
 * Genesis CRM AI Assistant — Popup Script
 */

(function () {
  'use strict';

  const $url = document.getElementById('pop-url');
  const $model = document.getElementById('pop-model');
  const $key = document.getElementById('pop-key');
  const $temp = document.getElementById('pop-temp');
  const $max = document.getElementById('pop-max');
  const $think = document.getElementById('pop-think');
  const $btnSave = document.getElementById('pop-save');
  const $btnTest = document.getElementById('pop-test');
  const $status = document.getElementById('pop-status');

  const $presetDsV3 = document.getElementById('pop-preset-deepseek-v3');
  const $presetDsR1 = document.getElementById('pop-preset-deepseek-r1');
  const $presetLocal = document.getElementById('pop-preset-local');

  function cleanApiKey(rawKey) {
    let key = (rawKey || '').trim();
    key = key.replace(/^Bearer\s+/i, '');
    key = key.replace(/^["'«»“”‘’`]|["'«»“”‘’`]$/g, '').trim();
    key = key.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n|\r/g, '');
    return key;
  }

  // Load current settings
  chrome.runtime.sendMessage({ action: 'getSettings' }, (res) => {
    if (res && res.settings) {
      $url.value = res.settings.apiUrl || '';
      $model.value = res.settings.model || '';
      $key.value = res.settings.apiKey || '';
      $temp.value = res.settings.temperature ?? 0.7;
      $max.value = res.settings.max_tokens ?? 2048;
      $think.value = res.settings.thinking_budget_tokens ?? 0;
    }
  });

  // Presets
  $presetDsV3?.addEventListener('click', () => {
    $url.value = 'https://api.deepseek.com/chat/completions';
    $model.value = 'deepseek-chat';
    $temp.value = '0.7';
    $max.value = '4096';
    $think.value = '0';
    $key.focus();
    showStatus('ok', 'Выбран DeepSeek V3. Введите API-ключ (sk-...)');
  });

  $presetDsR1?.addEventListener('click', () => {
    $url.value = 'https://api.deepseek.com/chat/completions';
    $model.value = 'deepseek-reasoner';
    $max.value = '4096';
    $think.value = '0';
    $key.focus();
    showStatus('ok', 'Выбран DeepSeek R1. Введите API-ключ (sk-...)');
  });

  $presetLocal?.addEventListener('click', () => {
    $url.value = 'http://localhost:11434/v1/chat/completions';
    $model.value = 'qwen2.5:latest';
    $temp.value = '0.7';
    $max.value = '2048';
    $think.value = '0';
    showStatus('ok', 'Выбран локальный Ollama');
  });

  // Save
  $btnSave.addEventListener('click', () => {
    const tempVal = parseFloat($temp.value);
    const maxVal = $max.value.trim();
    const thinkVal = $think.value.trim();
    const rawKey = $key.value.trim();
    const key = cleanApiKey(rawKey);
    if (rawKey !== key) $key.value = key;

    const newSettings = {
      apiUrl: $url.value.trim(),
      model: $model.value.trim(),
      apiKey: key,
      temperature: !isNaN(tempVal) ? tempVal : 0.7,
      max_tokens: maxVal !== '' ? parseInt(maxVal, 10) : 2048,
      thinking_budget_tokens: thinkVal !== '' ? parseInt(thinkVal, 10) : 0
    };

    chrome.runtime.sendMessage({ action: 'saveSettings', settings: newSettings }, (res) => {
      if (res && res.success) {
        showStatus('ok', 'Настройки сохранены');
        setTimeout(() => { $status.style.display = 'none'; }, 2000);
      } else {
        showStatus('err', 'Ошибка сохранения');
      }
    });
  });

  // Test
  $btnTest.addEventListener('click', () => {
    showStatus('ok', 'Проверка соединения...');
    $btnTest.disabled = true;

    const tempVal = parseFloat($temp.value);
    const maxVal = $max.value.trim();
    const thinkVal = $think.value.trim();
    const rawKey = $key.value.trim();
    const key = cleanApiKey(rawKey);

    chrome.runtime.sendMessage({
      action: 'testConnection',
      settings: {
        apiUrl: $url.value.trim(),
        model: $model.value.trim(),
        apiKey: key,
        temperature: !isNaN(tempVal) ? tempVal : 0.7,
        max_tokens: maxVal !== '' ? parseInt(maxVal, 10) : 2048,
        thinking_budget_tokens: thinkVal !== '' ? parseInt(thinkVal, 10) : 0
      }
    }, (res) => {
      $btnTest.disabled = false;
      if (res && res.success) {
        showStatus('ok', `Связь установлена (${res.reply})`);
      } else {
        showStatus('err', `Ошибка: ${res?.error || 'Не удалось связаться'}`);
      }
    });
  });

  function showStatus(type, msg) {
    $status.className = 'status ' + type;
    $status.textContent = msg;
    $status.style.display = 'block';
  }
})();
