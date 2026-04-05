/**
 * find_chat_button.js
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Boss直聘「立即沟通」按钮选择器调试脚本
 * 
 * 使用方法：
 * 1. 打开 Boss直聘 职位详情页
 * 2. 按 F12 打开 DevTools → Console 标签
 * 3. 粘贴以下代码并回车
 * 4. 将输出结果发送给开发者
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

(function() {
  'use strict';
  
  console.group('🔍 Boss直聘「立即沟通」按钮诊断');
  console.log('⏰ 诊断时间:', new Date().toLocaleString());
  console.log('📍 当前URL:', window.location.href);
  
  // ── 1. 文字内容匹配 ────────────────────────────────────────────────
  console.group('📝 文字内容匹配');
  const targetTexts = [
    '立即沟通', '继续沟通', '直接沟通', '打招呼', 
    '沟通', '联系我', '马上沟通', '快速沟通'
  ];
  
  const allElements = document.querySelectorAll('*');
  const textMatches = [];
  
  allElements.forEach(el => {
    const text = el.textContent?.trim();
    if (text && targetTexts.includes(text)) {
      textMatches.push({
        tag: el.tagName.toLowerCase(),
        text: text,
        id: el.id || null,
        className: el.className?.toString().trim() || null,
        dataAttrs: Array.from(el.attributes)
          .filter(attr => attr.name.startsWith('data-'))
          .map(attr => `${attr.name}="${attr.value}"`)
          .join(' '),
        isVisible: isElementVisible(el),
        isClickable: isElementClickable(el),
        outerHTML: el.outerHTML.substring(0, 300),
        parentInfo: el.parentElement ? {
          tag: el.parentElement.tagName.toLowerCase(),
          className: el.parentElement.className?.toString().trim().substring(0, 100) || null,
          id: el.parentElement.id || null
        } : null
      });
    }
  });
  
  if (textMatches.length > 0) {
    console.log(`✅ 找到 ${textMatches.length} 个匹配文字的元素:`);
    textMatches.forEach((match, i) => {
      console.log(`  [${i + 1}] <${match.tag}> "${match.text}"`, {
        可见: match.isVisible,
        可点击: match.isClickable,
        ID: match.id,
        类名: match.className,
        data属性: match.dataAttrs || '(无)',
        父元素: match.parentInfo,
        完整HTML: match.outerHTML
      });
    });
  } else {
    console.warn('❌ 未找到包含目标文字的可见元素');
  }
  console.groupEnd();
  
  // ── 2. CSS 选择器测试 ─────────────────────────────────────────────
  console.group('🎯 CSS 选择器测试');
  const cssSelectors = [
    // 常见按钮选择器
    '.op-btn-chat',
    '.btn-chat', 
    '.start-chat-btn',
    '.link-btn-chat',
    '.communicate-btn',
    '.im-btn',
    '.chat-btn',
    '.job-btn-chat',
    
    // 带 data 属性的选择器
    '[data-ka*="chat"]',
    '[data-ka*="沟通"]',
    '[data-testid*="chat"]',
    '[data-testid*="communicate"]',
    '[data-action*="chat"]',
    
    // 链接形式
    'a[href*="/web/im/"]',
    'a[href*="/chat/"]',
    'a[ka*="chat"]',
    
    // 通用按钮选择器
    'button[class*="chat"]',
    'button[class*="沟通"]',
    'a[class*="chat"]',
    'a[class*="沟通"]',
    
    // 角色按钮
    '[role="button"][class*="chat"]',
    '[role="button"][class*="沟通"]',
  ];
  
  const cssResults = [];
  cssSelectors.forEach(sel => {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const result = {
          selector: sel,
          found: true,
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 30) || null,
          id: el.id || null,
          className: el.className?.toString().trim().substring(0, 80) || null,
          isVisible: isElementVisible(el),
          isClickable: isElementClickable(el),
          outerHTML: el.outerHTML.substring(0, 200)
        };
        cssResults.push(result);
        console.log(`✅ ${sel}`, result);
      }
    } catch (e) {
      console.warn(`⚠️ ${sel} 选择器错误:`, e.message);
    }
  });
  
  if (cssResults.length === 0) {
    console.warn('❌ 所有预设选择器都未命中');
  } else {
    console.log(`📊 共 ${cssResults.length} 个选择器命中`);
  }
  console.groupEnd();
  
  // ── 3. 所有可点击元素扫描 ──────────────────────────────────────────
  console.group('🖱️ 可点击元素扫描（前20个）');
  const clickableSelectors = 'a, button, [role="button"], [onclick], [data-action]';
  const clickableElements = document.querySelectorAll(clickableSelectors);
  
  const clickableMatches = [];
  clickableElements.forEach(el => {
    const text = el.textContent?.trim();
    const isTarget = text && targetTexts.some(t => text.includes(t));
    
    if (isTarget || clickableMatches.length < 20) {
      clickableMatches.push({
        tag: el.tagName.toLowerCase(),
        text: text?.substring(0, 30) || null,
        selector: generateSelector(el),
        isVisible: isElementVisible(el),
        isClickable: isElementClickable(el),
        isTarget: isTarget,
        outerHTML: el.outerHTML.substring(0, 200)
      });
    }
  });
  
  const targetElements = clickableMatches.filter(m => m.isTarget);
  const otherElements = clickableMatches.filter(m => !m.isTarget);
  
  console.log(`🎯 找到 ${targetElements.length} 个目标相关元素:`);
  targetElements.forEach((el, i) => {
    console.log(`  [${i + 1}]`, el);
  });
  
  if (otherElements.length > 0) {
    console.log(`📋 其他可点击元素（前10个）:`);
    otherElements.slice(0, 10).forEach((el, i) => {
      console.log(`  [${i + 1}]`, el);
    });
  }
  console.groupEnd();
  
  // ── 4. 动态类名分析 ───────────────────────────────────────────────
  console.group('🔤 动态类名分析');
  const dynamicClassElements = document.querySelectorAll('[class*="chat"], [class*="btn"], [class*="im"]');
  const classPatterns = {};
  
  dynamicClassElements.forEach(el => {
    const classes = el.className?.toString().split(' ') || [];
    classes.forEach(cls => {
      if (cls && (cls.includes('chat') || cls.includes('btn') || cls.includes('im'))) {
        if (!classPatterns[cls]) {
          classPatterns[cls] = {
            className: cls,
            count: 0,
            elements: [],
            commonParent: null
          };
        }
        classPatterns[cls].count++;
        if (classPatterns[cls].elements.length < 3) {
          classPatterns[cls].elements.push({
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().substring(0, 20),
            id: el.id || null,
            selector: generateSelector(el)
          });
        }
      }
    });
  });
  
  const sortedPatterns = Object.values(classPatterns)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  if (sortedPatterns.length > 0) {
    console.log('📊 出现频率最高的类名:', sortedPatterns);
  } else {
    console.warn('⚠️ 未找到包含 chat/btn/im 的类名');
  }
  console.groupEnd();
  
  // ── 5. 一键测试 ───────────────────────────────────────────────────
  console.group('🧪 一键测试');
  if (textMatches.length > 0) {
    const bestMatch = textMatches.find(m => m.isVisible && m.isClickable) || textMatches[0];
    console.log(`🎯 最佳匹配元素:`, bestMatch);
    
    if (bestMatch.isVisible && bestMatch.isClickable) {
      console.log('✅ 元素可见且可点击，建议的选择器:', generateSelector(bestMatch));
    } else {
      console.warn('⚠️ 元素可能被遮挡或不可点击');
    }
  } else {
    console.error('❌ 未找到可测试的元素');
  }
  console.groupEnd();
  
  // ── 6. 页面结构快照 ──────────────────────────────────────────────
  console.group('📸 页面结构快照');
  console.log('body 类名:', document.body.className?.toString().substring(0, 200));
  console.log('body ID:', document.body.id);
  
  // 查找可能的容器
  const containers = document.querySelectorAll('[class*="detail"], [class*="job"], [class*="position"]');
  console.log(`找到 ${containers.length} 个可能的容器元素`);
  
  // 查找弹窗
  const dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"]');
  console.log(`找到 ${dialogs.length} 个弹窗元素`);
  console.groupEnd();
  
  console.groupEnd(); // 结束主分组
  
  // ── 辅助函数 ──────────────────────────────────────────────────────
  
  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 && 
      rect.height > 0 && 
      style.visibility !== 'hidden' && 
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }
  
  function isElementClickable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    
    // 检查是否可见
    if (!isElementVisible(el)) return false;
    
    // 检查是否有 pointer-events: none
    if (style.pointerEvents === 'none') return false;
    
    // 检查是否被其他元素遮挡
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(centerX, centerY);
    
    return topElement === el || el.contains(topElement);
  }
  
  function generateSelector(el) {
    if (el.id) return `#${el.id}`;
    
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(' ').slice(0, 2).join('.');
      if (classes) selector += '.' + classes;
    }
    
    // 添加 nth-child 如果必要
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-child(${index})`;
      }
    }
    
    return selector;
  }
  
  // ── 导出结果 ──────────────────────────────────────────────────────
  console.log('\n📋 诊断完成！请复制以上所有输出发送给开发者。');
  console.log('💡 如果「立即沟通」按钮确实存在但无法识别，请尝试手动点击按钮后再运行此脚本。');
  
})();