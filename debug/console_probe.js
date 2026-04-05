/**
 * console_probe.js
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 在 Boss 直聘职位详情/搜索结果页 打开 DevTools → Console 标签
 * 把下面整段代码粘贴进去并回车，即可看到诊断报告
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

(function probe() {
  console.group('🔍 Boss 直聘 DOM 诊断');

  // ── 1. 找「立即沟通」类按钮 ────────────────────────────────────────────────
  console.group('1️⃣  「立即沟通」按钮候选');
  const chatTextKeywords = ['立即沟通', '继续沟通', '直接沟通', '打招呼', '沟通'];
  const allClickable = document.querySelectorAll(
    'a, button, span, div, [role="button"]'
  );
  let foundChatBtns = [];
  allClickable.forEach((el) => {
    const text = el.textContent?.trim();
    if (chatTextKeywords.some((k) => text === k || text.startsWith(k))) {
      const info = {
        tag:        el.tagName.toLowerCase(),
        text:       text.slice(0, 30),
        id:         el.id || '(无)',
        class:      el.className?.toString().trim().slice(0, 80) || '(无)',
        dataAttrs:  [...el.attributes]
                      .filter((a) => a.name.startsWith('data-'))
                      .map((a) => `${a.name}="${a.value}"`)
                      .join(' ') || '(无)',
        visible:    (() => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })(),
        outerHTML:  el.outerHTML.slice(0, 200),
      };
      foundChatBtns.push(info);
      console.log(`✅ [${info.tag}] "${info.text}"`, info);
    }
  });
  if (!foundChatBtns.length) console.warn('⚠️  未找到包含「沟通」文字的元素');
  console.groupEnd();

  // ── 2. 已知 CSS 选择器测试 ────────────────────────────────────────────────
  console.group('2️⃣  CSS 选择器命中情况');
  const cssSelectors = [
    '.op-btn-chat',
    '.btn-chat',
    '[class*="btn-chat"]',
    '[class*="chat-btn"]',
    '.start-chat-btn',
    '.link-btn-chat',
    '[data-testid="chat-btn"]',
    '[data-testid*="chat"]',
    '[data-ka*="chat"]',
    'a[href*="/web/im"]',
    'a[href*="/chat"]',
  ];
  cssSelectors.forEach((sel) => {
    try {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`✅ ${sel}`, {
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 30),
          class: el.className?.toString().trim().slice(0, 80),
          outerHTML: el.outerHTML.slice(0, 200),
        });
      } else {
        console.log(`❌ ${sel} → 未命中`);
      }
    } catch (e) {
      console.warn(`⚠️  ${sel} 选择器报错: ${e.message}`);
    }
  });
  console.groupEnd();

  // ── 3. 聊天输入框探测 ────────────────────────────────────────────────────
  console.group('3️⃣  聊天输入框候选');
  const inputSelectors = [
    '.dialog-textarea',
    '[contenteditable="true"]',
    'textarea',
    '[role="textbox"]',
    '[data-testid*="input"]',
    '[data-testid*="editor"]',
    '[class*="textarea"]',
    '[class*="editor"]',
    '[class*="input"]',
  ];
  inputSelectors.forEach((sel) => {
    const els = document.querySelectorAll(sel);
    els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (visible || sel === '[contenteditable="true"]') {
        console.log(`${visible ? '✅' : '👁️ (隐藏)'} ${sel}`, {
          tag:           el.tagName,
          class:         el.className?.toString().trim().slice(0, 80),
          placeholder:   el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '(无)',
          dataAttrs:     [...el.attributes]
                           .filter((a) => a.name.startsWith('data-'))
                           .map((a) => `${a.name}="${a.value}"`)
                           .join(' ') || '(无)',
          contenteditable: el.contentEditable,
          outerHTML:     el.outerHTML.slice(0, 200),
        });
      }
    });
  });
  console.groupEnd();

  // ── 4. data-* 属性全局扫描 ────────────────────────────────────────────────
  console.group('4️⃣  含 data-* 属性的交互元素（前20个）');
  const withData = [...document.querySelectorAll('[data-testid],[data-ka],[data-action],[data-type]')];
  withData.slice(0, 20).forEach((el) => {
    console.log(`[${el.tagName.toLowerCase()}] text="${el.textContent?.trim().slice(0,20)}"`, {
      dataAttrs: [...el.attributes]
                   .filter((a) => a.name.startsWith('data-'))
                   .map((a) => `${a.name}="${a.value}"`)
                   .join(' '),
    });
  });
  if (!withData.length) console.warn('⚠️  当前页面没有 data-testid / data-ka / data-action 属性');
  console.groupEnd();

  // ── 5. 快捷测试：直接点击找到的第一个「立即沟通」按钮 ────────────────────
  console.group('5️⃣  一键测试：点击第一个「立即沟通」并等待输入框');
  const anyText = [...document.querySelectorAll('a,button,span,div,[role="button"]')]
    .find((el) => el.textContent?.trim() === '立即沟通');
  if (anyText) {
    console.log('找到按钮，2秒后自动点击并扫描输入框...', anyText);
    setTimeout(() => {
      anyText.click();
      console.log('✅ 已点击「立即沟通」，等待 3 秒扫描输入框...');
      setTimeout(() => {
        console.group('输入框扫描结果：');
        [
          '[contenteditable="true"]',
          'textarea',
          '[role="textbox"]',
          '[class*="textarea"]',
          '[class*="editor"]',
        ].forEach((s) => {
          document.querySelectorAll(s).forEach((e) => {
            const r = e.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              console.log('🎯 可见输入框:', {
                sel: s, tag: e.tagName, class: e.className?.toString().trim().slice(0,80),
                placeholder: e.getAttribute('placeholder') || e.getAttribute('data-placeholder'),
                outerHTML: e.outerHTML.slice(0, 200),
              });
            }
          });
        });
        console.groupEnd();
      }, 3000);
    }, 2000);
  } else {
    console.warn('❌ 未找到文字为「立即沟通」的按钮，请先点击一个职位查看右侧面板');
  }
  console.groupEnd();

  console.groupEnd(); // 🔍 诊断结束
})();
