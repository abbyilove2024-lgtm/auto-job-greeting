/**
 * sender.js
 * Content Script — 在 Boss直聘职位详情页自动点击「立即沟通」并发送消息
 * 由 service_worker 通过 chrome.scripting.executeScript 动态注入
 */

(function () {
  'use strict';

  // ── DOM 选择器（多重 fallback，适应页面结构变更）─────────────────────────────
  const SEL = {
    // 职位详情页标记（用于判断页面已渲染）
    jobDetail: [
      '.job-detail',
      '.job-banner',
      '.job-name',
      '[class*="job-name"]',
      '.job-info',
    ],

    // 「立即沟通 / 继续沟通 / 直接沟通」按钮
    chatBtn: [
      '.op-btn-chat',
      '.btn-chat',
      '[class*="chat-btn"]',
      '.start-chat-btn',
      'a[ka*="chat"]',
      '.chat-op-btn',
      '[data-ka*="chat"]',
    ],

    // 聊天输入框（点击「立即沟通」后弹出的面板里的输入区域）
    chatInput: [
      '#chat-input',
      'textarea#chat-input',
      '.dialog-textarea',
      '.editor-content[contenteditable="true"]',
      '[contenteditable="true"][class*="editor"]',
      '[contenteditable="true"][placeholder*="输入"]',
      '[contenteditable="true"][placeholder*="说点"]',
      '.chat-input [contenteditable="true"]',
      '[class*="chat-dialog"] [contenteditable="true"]',
      '[class*="im-dialog"] [contenteditable="true"]',
      '[class*="chat-box"] [contenteditable="true"]',
      'textarea[placeholder*="输入"]',
    ],

    // 发送按钮
    sendBtn: [
      '.send-msg',
      '.btn-send',
      '[class*="send-btn"]',
      'button[class*="send"]',
      '.chat-op .btn',
    ],

    // 聊天弹窗容器（用于判断面板已打开）
    chatPanel: [
      '.chat-dialog',
      '.job-chat',
      '.im-dialog',
      '[class*="chat-dialog"]',
      '[class*="im-dialog"]',
      '.float-layer',
    ],

    // 「您今日的招呼次数已用完」提示
    limitHint: [
      '[class*="limit"]',
      '[class*="quota"]',
      '.dialog-container',
    ],
  };

  // ── 监听来自 service_worker 的发送指令 ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_SEND') {
      console.log('[Sender] 收到发送指令，岗位:', msg.job?.jobTitle);
      executeSend(msg.message, msg.job)
        .then((result) => {
          console.log('[Sender] 发送结果:', result);
          sendResponse(result);
        })
        .catch((err) => {
          console.error('[Sender] executeSend 异常:', err);
          sendResponse({ success: false, error: err.message, code: 'EXCEPTION' });
        });
      return true; // 异步响应
    }
  });

  console.log('[Sender] 已注入，等待发送指令...');

  // ── 核心发送流程 ───────────────────────────────────────────────────────────────

  async function executeSend(message, job) {
    // Step 1: 等待职位详情页加载完成
    const pageReady = await waitForJobDetail();
    if (!pageReady) {
      return { success: false, error: '职位详情页加载超时', code: 'PAGE_TIMEOUT' };
    }

    // Step 2: 检查是否已经有聊天输入框（已打开过的面板）
    let inputEl = findFirstVisible(SEL.chatInput);

    if (!inputEl) {
      // Step 3: 寻找「立即沟通」按钮
      const chatBtn = await findChatButton();

      if (!chatBtn) {
        if (detectLoginRequired()) {
          return { success: false, error: '需要登录 Boss 直聘', code: 'NOT_LOGGED_IN' };
        }
        return { success: false, error: '未找到「立即沟通」按钮，职位可能已下线', code: 'NO_CHAT_BTN' };
      }

      console.log('[Sender] 点击「立即沟通」:', chatBtn.textContent?.trim());
      const opened = await openChatPanel(chatBtn);
      if (!opened) {
        const blockedMsg = detectChatOpenBlocked();
        if (blockedMsg) {
          return { success: false, error: blockedMsg, code: 'CHAT_OPEN_BLOCKED' };
        }
      }

      // Step 4: 等待聊天面板出现 + 输入框就绪
      inputEl = await waitForChatInput(10000);
    }

    if (!inputEl) {
      // 检测是否弹出了「今日招呼次数已用完」等限制弹窗
      const limitMsg = detectLimitDialog();
      if (limitMsg) {
        return { success: false, error: limitMsg, code: 'LIMIT_REACHED' };
      }
      return { success: false, error: '聊天输入框未出现（面板未打开）', code: 'NO_INPUT' };
    }

    // Step 5: 滚动确保可见，聚焦输入框
    inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);
    inputEl.click();
    inputEl.focus();
    await sleep(randomInt(300, 600));

    // Step 6: 输入消息
    await typeMessage(inputEl, message);
    await sleep(randomInt(500, 900));

    // Step 7: 发送
    const sent = await triggerSend(inputEl);
    await sleep(1000);

    if (!sent) {
      return { success: false, error: '触发发送失败', code: 'SEND_FAILED' };
    }

    // Step 8: 确认消息已出现在聊天记录（可选验证）
    await sleep(800);

    return { success: true };
  }

  // ── 等待职位详情页加载 ─────────────────────────────────────────────────────────

  function waitForJobDetail(timeout = 12000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (findFirstVisible(SEL.jobDetail)) { resolve(true); return; }
        if (Date.now() - start > timeout)    { resolve(false); return; }
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  // ── 寻找「立即沟通」按钮 ───────────────────────────────────────────────────────

  async function findChatButton(timeout = 8000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // 方法1：通过 CSS 选择器
      const bySelector = findFirstVisible(SEL.chatBtn);
      if (bySelector) {
        console.log('[findChatButton] 通过CSS选择器找到按钮');
        return bySelector;
      }

      // 方法2：通过文字内容匹配（更可靠），包括模糊匹配
      const textPatterns = ['立即沟通', '继续沟通', '直接沟通', '联系我', '沟通'];
      const allClickable = document.querySelectorAll(
        'a, button, span[class*="btn"], div[class*="btn"], .op-btn, [role="button"]'
      );
      for (const el of allClickable) {
        const text = el.textContent?.trim();
        // 精确匹配优先
        if (textPatterns.includes(text) && isVisible(el)) {
          console.log('[findChatButton] 通过文字精确匹配找到按钮:', text);
          return el;
        }
        // 模糊匹配（包含关键字且长度合理）
        if (textPatterns.some(p => text && text.includes(p)) && isVisible(el) && text.length < 20) {
          console.log('[findChatButton] 通过文字模糊匹配找到按钮:', text);
          return el;
        }
      }

      await sleep(500);
    }

    console.warn('[findChatButton] 超时：未找到「立即沟通」按钮');
    return null;
  }

  // ── 等待聊天输入框出现 ─────────────────────────────────────────────────────────

  function waitForChatInput(timeout = 10000) {
    const enhancedSelectors = [
      '.dialog-textarea',
      '.editor-content[contenteditable="true"]',
      '[contenteditable="true"][class*="editor"]',
      '[contenteditable="true"][placeholder*="输入"]',
      '[contenteditable="true"][placeholder*="说点"]',
      '[contenteditable="true"][placeholder*="聊"]',
      '[contenteditable="true"][placeholder*="消息"]',
      '[contenteditable="true"][placeholder*="给"]',
      '[contenteditable="true"][placeholder*="留言"]',
      '[class*="chat-input"] [contenteditable="true"]',
      '[class*="chat-dialog"] [contenteditable="true"]',
      '[class*="im-dialog"] [contenteditable="true"]',
      '[class*="chat-box"] [contenteditable="true"]',
      '[class*="dialog"] [contenteditable="true"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="说点"]',
      'textarea[placeholder*="给"]',
      '[contenteditable="true"]',
    ];

    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const el = findFirstVisible(enhancedSelectors);
        if (el) {
          console.log('[waitForChatInput] 找到输入框');
          resolve(el);
          return;
        }
        if (Date.now() - start > timeout) {
          console.warn('[waitForChatInput] 超时：未找到聊天输入框');
          resolve(null);
          return;
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  async function openChatPanel(chatBtn, timeout = 12000) {
    const urlBefore = window.location.href;
    const clickableTargets = getClickableTargets(chatBtn);
    const chatHref = clickableTargets
      .map((el) => el?.href)
      .find((href) => typeof href === 'string' && /\/web\/(im|chat)\//.test(href));

    const deadline = Date.now() + timeout;
    let hrefTried = false;

    while (Date.now() < deadline) {
      if (findFirstVisible(SEL.chatInput)) return true;

      for (const target of clickableTargets) {
        activateElement(target);
        await sleep(700);

        if (window.location.href !== urlBefore) {
          await sleep(1800);
        }

        if (findFirstVisible(SEL.chatInput) || findFirstVisible(SEL.chatPanel)) {
          return true;
        }
      }

      if (!hrefTried && chatHref) {
        hrefTried = true;
        window.location.assign(chatHref);
        await sleep(2500);
        if (findFirstVisible(SEL.chatInput) || findFirstVisible(SEL.chatPanel)) {
          return true;
        }
      }

      await sleep(500);
    }

    return !!(findFirstVisible(SEL.chatInput) || findFirstVisible(SEL.chatPanel));
  }

  function getClickableTargets(el) {
    const targets = [];
    const push = (candidate) => {
      if (!candidate || targets.includes(candidate) || !isVisible(candidate)) return;
      targets.push(candidate);
    };

    push(el);
    push(el.closest('a[href]'));
    push(el.closest('button'));
    push(el.closest('[role="button"]'));
    push(el.closest('.op-btn'));
    push(el.closest('[class*="btn"]'));
    push(el.parentElement);

    return targets;
  }

  function activateElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {}
    });
    try { el.click(); } catch (_) {}
  }

  // ── 检测日发送上限 ─────────────────────────────────────────────────────────────

  function detectLimitDialog() {
    const hints = [
      '今日招呼次数已用完',
      '今日已达到打招呼上限',
      '每日沟通上限',
      '沟通次数',
      '频率限制',
    ];

    const allText = document.body.innerText || '';
    for (const h of hints) {
      if (allText.includes(h)) return h;
    }

    // 检测是否有弹窗
    for (const sel of SEL.limitHint) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const text = el.textContent?.trim();
        if (text && text.length < 100) return text;
      }
    }

    return null;
  }

  function detectChatOpenBlocked() {
    const hints = [
      '你已经有一次请求打开过立即沟通了',
      '已发起过沟通',
      '请勿重复发起沟通',
      '请稍后再试',
    ];
    const bodyText = document.body.innerText || '';
    return hints.find((hint) => bodyText.includes(hint)) || null;
  }

  // ── 检测是否需要登录 ───────────────────────────────────────────────────────────

  function detectLoginRequired() {
    return (
      window.location.href.includes('/web/user/') ||
      window.location.href.includes('login') ||
      document.body.innerText.includes('请先登录') ||
      !!document.querySelector('.login-dialog, .login-panel, [class*="login-btn"]')
    );
  }

  // ── 模拟输入消息 ───────────────────────────────────────────────────────────────

  async function typeMessage(inputEl, message) {
    // 清空现有内容
    if (inputEl.isContentEditable) {
      inputEl.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } else {
      inputEl.value = '';
    }

    // 逐块插入，模拟真实打字节奏
    if (inputEl.isContentEditable) {
      const chunks = chunkString(message, randomInt(8, 15));
      for (const chunk of chunks) {
        document.execCommand('insertText', false, chunk);
        await sleep(randomInt(25, 70));
      }
    } else {
      inputEl.value = message;
    }

    // 触发 React/Vue 数据绑定感知
    fireEvents(inputEl, ['input', 'change', 'keyup']);
  }

  // ── 触发发送 ───────────────────────────────────────────────────────────────────

  async function triggerSend(inputEl) {
    // 方法1：Enter 键（Boss 直聘默认 Enter 发送，Shift+Enter 换行）
    const kbOpts = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    inputEl.dispatchEvent(new KeyboardEvent('keydown',  kbOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', kbOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keyup',    kbOpts));
    await sleep(300);

    // 方法2：点击发送按钮（fallback）
    const sendBtn = findFirstVisible(SEL.sendBtn);
    if (sendBtn) {
      sendBtn.click();
      await sleep(300);
    }

    return true;
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────────

  /** 依次尝试选择器数组，返回第一个可见元素 */
  function findFirstVisible(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (_) { /* 忽略无效选择器 */ }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      window.getComputedStyle(el).visibility !== 'hidden' &&
      window.getComputedStyle(el).display !== 'none'
    );
  }

  function fireEvents(el, types) {
    types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
  }

  function chunkString(str, size) {
    const chunks = [];
    for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
    return chunks;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
