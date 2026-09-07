// injects/ui.js - 核心 UI 渲染及批量生成自动化控制脚本 (支持手动 JSON 导出对接与断点重载刷新)

(function() {
  "use strict";
  if (window.top !== window) return;

  console.log("[FlowUI] 界面控制器正在初始化...");

  // ----------------------------------------------------
  // 0. Trusted Types 兼容与安全 DOM 操作封装 (针对 flow.google.com CSP 限制)
  // ----------------------------------------------------
  let flowTrustedPolicy = null;
  if (typeof window !== "undefined" && window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      flowTrustedPolicy = window.trustedTypes.createPolicy("flow-ui-policy", {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    } catch (e) {
      try {
        flowTrustedPolicy = window.trustedTypes.createPolicy("default", {
          createHTML: (s) => s,
          createScript: (s) => s,
          createScriptURL: (s) => s,
        });
      } catch (err) {
        flowTrustedPolicy = window.trustedTypes.defaultPolicy || null;
      }
    }
  }

  function setSafeHTML(element, htmlContent) {
    if (!element) return;
    try {
      if (flowTrustedPolicy) {
        element.innerHTML = flowTrustedPolicy.createHTML(htmlContent);
      } else if (window.trustedTypes && window.trustedTypes.defaultPolicy) {
        element.innerHTML = window.trustedTypes.defaultPolicy.createHTML(htmlContent);
      } else {
        element.innerHTML = htmlContent;
      }
    } catch (err) {
      console.warn("[FlowUI] innerHTML 受 Trusted Types 拦截，使用 DOMParser 安全降级注入:", err);
      try {
        const doc = new DOMParser().parseFromString(htmlContent, "text/html");
        element.replaceChildren(...doc.body.childNodes);
      } catch (domErr) {
        console.warn("[FlowUI] DOMParser 降级失败，尝试 ContextualFragment:", domErr);
        try {
          const range = document.createRange();
          range.selectNodeContents(document.documentElement || document.body);
          const fragment = range.createContextualFragment(htmlContent);
          element.replaceChildren(fragment);
        } catch (rangeErr) {
          console.error("[FlowUI] 无法注入 HTML 内容:", rangeErr);
        }
      }
    }
  }

  // ----------------------------------------------------
  // 1. 消息中间件（使用 window.postMessage 桥接后台）
  // ----------------------------------------------------
  const extensionCallbacks = new Map();

  function sendToExtension(action, data) {
    return new Promise((resolve) => {
      const callbackId = Math.random().toString(36).substring(2, 9);
      extensionCallbacks.set(callbackId, resolve);
      
      // 15秒超时保底，防止扩展桥接未就绪导致初始化永久阻塞
      setTimeout(() => {
        if (extensionCallbacks.has(callbackId)) {
          extensionCallbacks.delete(callbackId);
          console.warn(`[FlowUI] sendToExtension(${action}) 15秒无响应，自动跳过`);
          resolve({ error: "timeout" });
        }
      }, 15000);

      window.postMessage({
        sender: "flow-main",
        callbackId: callbackId,
        payload: { action, ...data }
      }, "*");
    });
  }

  // 监听来自 content-isolated.js 的响应与广播事件
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    
    if (event.data.sender === "flow-isolated-open-panel") {
      openPanel();
      return;
    }

    if (event.data.sender === "flow-isolated-event") {
      if (["downloadCompleted", "downloadFailed"].includes(event.data.event)) {
        const taskInfo = event.data.data?.task;
        console.log("[FlowUI] 收到后台下载完成广播通知:", taskInfo);
        if (taskInfo && taskInfo.projectId === getStorageKey()) {
          const r = taskInfo.rowIndex;
          const l = taskInfo.lineIndex;
          if (state.tasks[r]?.taskId === taskInfo.taskId && state.tasks[r]?.mediaBindings?.[l]?.submissionId === taskInfo.submissionId) {
            if (event.data.event === "downloadFailed") {
              updateLineStatus(r, l, "failed", `下载失败: ${event.data.data.error}`);
              return;
            }
            updateLineStatus(r, l, "success", `自动下载成功: ${taskInfo.download_path}`);
            if (Array.isArray(state.tasks[r].downloaded)) {
              state.tasks[r].downloaded[l] = true;
            }
            saveState();
          }
        }
      }
      return;
    }

    if (event.data.sender !== "flow-isolated") {
      return;
    }
    const { callbackId, response } = event.data;
    if (extensionCallbacks.has(callbackId)) {
      extensionCallbacks.get(callbackId)(response);
      extensionCallbacks.delete(callbackId);
    }
  });

  const downloadedUrlsSet = new Set();

  // ----------------------------------------------------
  // 2. 状态管理与配置项
  // ----------------------------------------------------
  let state = {
    tasks: [],             // 批量生成任务列表 (含 prompt, mode, image_name, local_image_path, duration, download_path, status, message, downloaded)
    taskRecord: {},        // mediaName -> 任务进度关联信息映射表
    activeTasksQueue: [],  // FIFO 活跃任务排队队列，用于与完成的视频松散匹配
    downloadedUrls: [],    // 已下载视频 URL 记录，防止重复下载
    settings: {
      interval: 20,        // 每次生成的间隔基数(秒)
      intervalRandom: 10,  // 随机抖动上限(秒)
      maxLetterFor4s: 40,  // 4s视频最大字数
      maxLetterFor6s: 60,  // 6s视频最大字数
      defaultCount: 1,     // 默认生成数量
      footageType: "VIDEO_FRAMES", // 默认素材类型 (VIDEO_FRAMES 帧模式)
      resolution: "VIDEO_RESOLUTION_720P", // 默认分辨率 (720p)
      aspectRatio: "ASPECT_RATIO_9_16",    // 尺寸比例 (默认 9:16 竖屏)
      videoModel: "VIDEO_REFERENCES"       // 生成模型 (默认 VIDEO_REFERENCES)
    },
    presets: [             // 提示词模板预设 (首尾拼接)
      { name: "无模版(直接填入)", content: "\n\n" },
      { name: "写实风格电影感", content: "A cinematic film of\n\n4k resolution, highly detailed, photorealistic." },
      { name: "3D卡通动画", content: "A 3D animated scene of\n\npixar style, vibrant colors, clay model." },
      { name: "极简插画", content: "A minimalist vector illustration of\n\nflat color, clean lines, modern design." }
    ],
    isRunning: false,
    isSuspended: false,
    activeProjectId: "",
    currentIndex: 0,       // 当前正在跑的任务索引
    currentLineIndex: 0,   // 当前正在跑的提示词分行索引
    retryCount: 0          // 单个任务失败刷新重试计数
  };

  // 生成缓存 KEY 规则：工程ID + 合集ID
  function getStorageKey() {
    const url = location.href;
    const projectMatch = url.match(/\/project\/([^/]+)/);
    const collectionMatch = url.match(/\/collection\/([^/]+)/);
    const pId = projectMatch ? projectMatch[1] : "";
    const cId = collectionMatch ? collectionMatch[1] : "";
    return [pId, cId].filter(Boolean).join("-") || "default-flow-project";
  }

  // 写入配置和状态到 Storage (通过插件 Background 存储)
  async function saveState() {
    const key = getStorageKey();
    state.activeProjectId = key;
    
    const dataToSave = {
      [`tasks_${key}`]: state.tasks,
      settings: state.settings,
      presets: state.presets,
      [`taskRecord_${key}`]: state.taskRecord,
      [`downloadedUrls_${key}`]: Array.from(downloadedUrlsSet),
      [`isRunning_${key}`]: state.isRunning,
      [`currentIndex_${key}`]: state.currentIndex,
      [`currentLineIndex_${key}`]: state.currentLineIndex,
      [`retryCount_${key}`]: state.retryCount
    };
    
    const res = await sendToExtension("setStorage", { data: dataToSave });
    if (res && res.error) {
      console.error("[FlowUI] 保存状态失败:", res.error);
      if (res.error.includes("失效") || res.error.includes("invalidated")) {
        showToast("检测到插件连接失效，请刷新网页以重新连接！", 8000);
      }
    }
  }

  // 从 Storage 读取配置和状态
  async function loadState() {
    const key = getStorageKey();
    state.activeProjectId = key;
    
    const saved = await sendToExtension("getStorage", {
      keys: [
        `tasks_${key}`, "settings", "presets", `taskRecord_${key}`, `downloadedUrls_${key}`,
        `isRunning_${key}`, `currentIndex_${key}`, `currentLineIndex_${key}`, `retryCount_${key}`
      ]
    });
    
    if (saved) {
      if (saved.error) {
        console.error("[FlowUI] 加载状态失败:", saved.error);
        if (saved.error.includes("失效") || saved.error.includes("invalidated")) {
          showToast("检测到插件连接失效或重启，请刷新网页以重新连接！", 8000);
        }
        return;
      }
      if (saved[`tasks_${key}`]) state.tasks = saved[`tasks_${key}`];
      if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
      if (saved.presets) state.presets = saved.presets;
      if (saved[`taskRecord_${key}`]) state.taskRecord = saved[`taskRecord_${key}`];
      if (saved[`downloadedUrls_${key}`] && Array.isArray(saved[`downloadedUrls_${key}`])) {
        state.downloadedUrls = saved[`downloadedUrls_${key}`];
        saved[`downloadedUrls_${key}`].forEach(u => downloadedUrlsSet.add(u));
      }
      if (saved[`isRunning_${key}`] !== undefined) state.isRunning = saved[`isRunning_${key}`];
      if (saved[`currentIndex_${key}`] !== undefined) state.currentIndex = saved[`currentIndex_${key}`];
      if (saved[`currentLineIndex_${key}`] !== undefined) state.currentLineIndex = saved[`currentLineIndex_${key}`];
      if (saved[`retryCount_${key}`] !== undefined) state.retryCount = saved[`retryCount_${key}`];
    }
  }

  // ----------------------------------------------------
  // 3. UI 界面构建
  // ----------------------------------------------------
  let fabEl = null;
  let overlayEl = null;
  let importDialogEl = null;
  let alarmDialogEl = null;

  function createUI() {
    const targetParent = document.body || document.documentElement;
    const existingFab = document.getElementById("flow-batch-fab");
    const existingOverlay = document.getElementById("flow-batch-overlay");
    if (existingFab && existingOverlay && targetParent && targetParent.contains(existingFab)) {
      return;
    }

    console.log("[FlowUI] 正在创建控制台 UI 界面...", location.href);

    if (!existingFab) {
      // 创建悬浮按钮 FAB (使用原生 DOM 及强力行内样式兜底，免疫 Trusted Types 与 CSS 加载延迟)
      fabEl = document.createElement("div");
      fabEl.id = "flow-batch-fab";
      fabEl.title = "打开批量生成助手";
      fabEl.style.cssText = "position: fixed !important; bottom: 120px !important; right: 24px !important; width: 56px !important; height: 56px !important; border-radius: 50% !important; background: linear-gradient(135deg, #8b5cf6, #3b82f6) !important; box-shadow: 0 8px 32px rgba(139, 92, 246, 0.6), inset 0 2px 4px rgba(255, 255, 255, 0.3) !important; display: flex !important; align-items: center !important; justify-content: center !important; cursor: pointer !important; z-index: 2147483647 !important; border: 2px solid rgba(255, 255, 255, 0.2) !important; box-sizing: border-box !important;";

      const fabSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      fabSvg.setAttribute("viewBox", "0 0 24 24");
      fabSvg.setAttribute("width", "28");
      fabSvg.setAttribute("height", "28");
      fabSvg.style.cssText = "width: 28px !important; height: 28px !important; fill: #ffffff !important; pointer-events: none !important;";

      const fabPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      fabPath.setAttribute("d", "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z");
      fabPath.setAttribute("fill", "#ffffff");

      fabSvg.appendChild(fabPath);
      fabEl.appendChild(fabSvg);

      fabEl.addEventListener("click", () => openPanel());

      if (targetParent) {
        targetParent.appendChild(fabEl);
        console.log("[FlowUI] FAB 按钮已挂载至:", targetParent.tagName);
      }
    } else {
      fabEl = existingFab;
      if (targetParent && !targetParent.contains(fabEl)) {
        targetParent.appendChild(fabEl);
      }
    }

    if (document.getElementById("flow-batch-overlay")) return;

    // 创建控制面板遮罩层 (使用 setSafeHTML 安全注入)
    overlayEl = document.createElement("div");
    overlayEl.id = "flow-batch-overlay";
    setSafeHTML(overlayEl, `
      <div id="flow-batch-panel">
        <div id="flow-batch-panel-header">
          <h2>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #a78bfa;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            Flow 批量生成与自动下载助手
          </h2>
          <div class="flow-close-btn" id="flow-panel-close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </div>
        </div>
        
        <div id="flow-batch-panel-content">
          <!-- 左侧：任务表格 -->
          <div id="flow-table-container">
            <table class="flow-table" id="flow-tasks-table">
              <thead>
                <tr>
                  <th style="width: 115px; text-align: center;">图片</th>
                  <th>提示词文本 (分行分割)</th>
                  <th style="width: 145px;">提示词模板</th>
                  <th style="width: 135px;">素材类型</th>
                  <th style="width: 85px;">时长（秒）</th>
                  <th style="width: 70px;">生成数</th>
                  <th style="width: 220px;">状态与日志</th>
                  <th style="width: 80px; text-align: center;">操作</th>
                </tr>
              </thead>
              <tbody>
                <!-- 动态渲染 -->
              </tbody>
            </table>
          </div>

          <!-- 右侧：设置面板 -->
          <div id="flow-settings-drawer">
            <h3 style="margin-top: 0; font-family: var(--flow-font-heading); font-size: 16px; border-bottom: 1px solid var(--flow-border-glass); padding-bottom: 10px;">自动化参数配置</h3>
            
            <div class="settings-group">
              <label>生成间隔基数 (秒)</label>
              <input type="number" class="settings-input" id="cfg-interval" min="5" value="20">
            </div>
            
            <div class="settings-group">
              <label>随机抖动时间 (秒)</label>
              <input type="number" class="settings-input" id="cfg-random" min="0" value="10">
            </div>
            
            <div class="settings-group">
              <label>4秒视频最大字数限额</label>
              <input type="number" class="settings-input" id="cfg-max4s" min="1" value="40">
            </div>
            
            <div class="settings-group">
              <label>6秒视频最大字数限额</label>
              <input type="number" class="settings-input" id="cfg-max6s" min="1" value="60">
            </div>

            <div class="settings-group">
              <label>画面尺寸 / 比例</label>
              <select class="settings-input" id="cfg-aspect" style="background: rgba(255,255,255,0.05); color: var(--flow-text-primary);">
                <option value="ASPECT_RATIO_9_16" selected>9:16 (竖屏 / 手机短视频 默认)</option>
                <option value="ASPECT_RATIO_16_9">16:9 (横屏 / 宽屏)</option>
                <option value="ASPECT_RATIO_1_1">1:1 (正方形)</option>
              </select>
            </div>

            <div class="settings-group">
              <label>视频生成模型</label>
              <select class="settings-input" id="cfg-model" style="background: rgba(255,255,255,0.05); color: var(--flow-text-primary);">
                <option value="VIDEO_REFERENCES" selected>VIDEO_REFERENCES (素材参考模型 默认)</option>
                <option value="veo_2">Veo 2 (高画质)</option>
                <option value="veo_3_1_lite_low_priority">Veo 3.1 Lite (低优先级 / 快速)</option>
                <option value="veo_fast">Veo Fast (极速模式)</option>
              </select>
            </div>

            <div class="settings-group">
              <label>清晰度 / 分辨率</label>
              <select class="settings-input" id="cfg-resolution" style="background: rgba(255,255,255,0.05); color: var(--flow-text-primary);">
                <option value="VIDEO_RESOLUTION_720P" selected>720p (高清 默认)</option>
                <option value="VIDEO_RESOLUTION_360P">360p (低分辨率 / 省流量)</option>
                <option value="VIDEO_RESOLUTION_1080P">1080p (全高清)</option>
              </select>
            </div>

            <div class="settings-group">
              <label>默认素材模式</label>
              <select class="settings-input" id="cfg-footagetype" style="background: rgba(255,255,255,0.05); color: var(--flow-text-primary);">
                <option value="VIDEO_FRAMES" selected>帧模式 (首帧作为起始视频帧 默认)</option>
                <option value="VIDEO_REFERENCES">素材模式 (图片作为参考物)</option>
              </select>
            </div>

            <div class="settings-group" style="margin-top: 20px; border-top: 1px solid var(--flow-border-glass); padding-top: 15px;">
              <label style="font-weight: 600;">模版自定义预设</label>
              <button class="flow-btn secondary" id="btn-add-preset" style="font-size: 12px; padding: 6px 12px;">新建模板</button>
              <div id="presets-list-container" style="display:flex; flex-direction:column; gap:8px; margin-top:8px; max-height: 180px; overflow-y:auto;">
                <!-- 预设列表 -->
              </div>
            </div>
          </div>
        </div>

        <div id="flow-batch-panel-footer">
          <div class="footer-actions-left">
            <button class="flow-btn secondary" id="btn-load-images">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              加载页面图片
            </button>
            <button class="flow-btn secondary" id="btn-open-import" style="border-color: #8b5cf6; color: #a78bfa;">
              导入外部 JSON
            </button>
            <button class="flow-btn secondary" id="btn-copy-report">
              导出结果报告
            </button>
            <button class="flow-btn secondary" id="btn-clear-tasks" style="color: #ef4444; border-color: rgba(239,68,68,0.2);" title="清空表格中的全部任务">
              清空全部任务列表
            </button>
          </div>
          <div class="footer-actions-right">
            <button class="flow-btn danger" id="btn-stop-batch" style="display: none !important;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
              停止生成
            </button>
            <button class="flow-btn primary" id="btn-start-batch">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              开始批量生成
            </button>
          </div>
        </div>
      </div>
    `);
    targetParent.appendChild(overlayEl);

    // 创建粘贴导入弹窗
    importDialogEl = document.createElement("div");
    importDialogEl.id = "flow-import-dialog";
    setSafeHTML(importDialogEl, `
      <div class="import-box">
        <h3 class="import-title">
          导入外部数据配置 (多套 JSON)
          <span style="font-size:11px; font-weight:normal; color:var(--flow-text-secondary);">支持多任务数组一键导入</span>
        </h3>
        <textarea class="import-textarea" id="flow-import-textarea" placeholder='请在此处粘贴 Python 导出的 JSON 数组配置...\n例如:\n[\n  {\n    "prompt": "Un perro corriendo",\n    "mode": "VIDEO_FRAMES",\n    "image_name": "dog.png",\n    "duration": 6,\n    "download_path": "D:\\\\videos\\\\project\\\\dog.mp4"\n  }\n]'></textarea>
        <div class="import-actions">
          <button class="flow-btn secondary" id="btn-import-cancel">取消</button>
          <button class="flow-btn primary" id="btn-import-confirm">确认导入</button>
        </div>
      </div>
    `);
    targetParent.appendChild(importDialogEl);

    // 创建异常活动报警弹窗
    alarmDialogEl = document.createElement("div");
    alarmDialogEl.id = "flow-alarm-dialog";
    alarmDialogEl.style.cssText = "display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(220, 38, 38, 0.15); backdrop-filter: blur(12px); z-index: 2147483646 !important; align-items: center; justify-content: center;";
    setSafeHTML(alarmDialogEl, `
      <div class="import-box" style="border-color: rgba(220, 38, 38, 0.4); box-shadow: 0 20px 48px rgba(220, 38, 38, 0.25);">
        <h3 class="import-title" style="color: #ef4444; display: flex; align-items: center; gap: 8px;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          🚨 检测到安全限制（异常活动）
        </h3>
        <p style="font-size: 14px; line-height: 1.6; color: var(--flow-text-primary); margin: 8px 0;">
          Google Flow 网页提示“我们发现了一些异常活动”安全拦截。
        </p>
        <p id="flow-alarm-message" style="font-size: 13px; color: #f59e0b; font-weight: 500; margin: 4px 0;">
          系统将在 45 秒后自动刷新网页以尝试恢复，您也可以立即进行手动处理...
        </p>
        <div class="import-actions" style="margin-top: 16px;">
          <button class="flow-btn secondary" id="btn-alarm-manual" style="border-color: rgba(245, 158, 11, 0.3); color: #f59e0b;">我来手动处理 (暂停倒计时)</button>
          <button class="flow-btn danger" id="btn-alarm-reload">立即刷新网页</button>
          <button class="flow-btn primary" id="btn-alarm-resume">消除限制，继续生成</button>
        </div>
      </div>
    `);
    targetParent.appendChild(alarmDialogEl);

    // 创建 Toast 元素
    const toast = document.createElement("div");
    toast.id = "flow-batch-toast";
    toast.className = "flow-toast";
    targetParent.appendChild(toast);

    // 安全绑定基础 UI 事件
    const safeOn = (id, event, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler);
      else console.warn(`[FlowUI] 挂载未找到元素 #${id}`);
    };

    safeOn("flow-panel-close", "click", () => closePanel());
    if (overlayEl) {
      overlayEl.addEventListener("click", (e) => {
        if (e.target === overlayEl) closePanel();
      });
    }

    // 绑定数据导入/导出/加载按钮
    safeOn("btn-load-images", "click", () => loadPageImages());
    safeOn("btn-open-import", "click", () => openImportDialog());
    safeOn("btn-import-cancel", "click", () => closeImportDialog());
    safeOn("btn-import-confirm", "click", () => handleJSONImport());
    safeOn("btn-copy-report", "click", () => copyExecutionReport());
    
    safeOn("btn-alarm-manual", "click", () => pauseAlarmCountdown());
    safeOn("btn-alarm-reload", "click", () => {
      if (alarmTimer) clearInterval(alarmTimer);
      saveState().then(() => location.reload());
    });
    safeOn("btn-alarm-resume", "click", () => resumeFromAlarm());
    
    safeOn("btn-clear-tasks", "click", () => {
      if (batchPromise) { showToast("请先停止队列，再清空任务列表"); return; }
      if (confirm("确定清空插件中的全部任务列表吗？Flow 云端项目和已下载文件不受影响。")) {
        state.tasks = [];
        state.taskRecord = {};
        state.activeTasksQueue = [];
        state.currentIndex = 0;
        state.currentLineIndex = 0;
        state.retryCount = 0;
        renderTable();
        saveState();
        showToast("已清空全部任务列表");
      }
    });

    overlayEl.addEventListener("click", event => {
      if (!batchPromise) return;
      const target = event.target.closest("button, input, select, textarea");
      if (!target) return;
      if (target.closest("#flow-tasks-table") || ["btn-open-import", "btn-load-images", "btn-clear-tasks"].includes(target.id)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showToast("请先停止队列，再修改任务");
      }
    }, true);
    safeOn("btn-start-batch", "click", () => startBatch());
    safeOn("btn-stop-batch", "click", () => stopBatch());

    bindSettingsEvents();
  }

  function showToast(message, duration = 3000) {
    let el = document.getElementById("flow-batch-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "flow-batch-toast";
      el.className = "flow-toast";
      (document.body || document.documentElement).appendChild(el);
    }
    el.innerText = message;
    el.style.cssText = "position: fixed !important; bottom: 24px !important; left: 24px !important; background: rgba(18, 18, 22, 0.95) !important; backdrop-filter: blur(8px) !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; padding: 12px 24px !important; border-radius: 12px !important; color: #f3f4f6 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5) !important; font-size: 14px !important; z-index: 2147483647 !important; transform: translateY(0) !important; opacity: 1 !important; pointer-events: none !important; display: block !important;";
    el.classList.add("show");
    setTimeout(() => {
      el.classList.remove("show");
      el.style.setProperty("display", "none", "important");
    }, duration);
  }

  async function openPanel() {
    console.log("[FlowUI] 正在呼出主控制面板...");
    if (!overlayEl) overlayEl = document.getElementById("flow-batch-overlay");
    if (!overlayEl) {
      console.warn("[FlowUI] 遮罩层丢失，正在重新创建 UI...");
      createUI();
      overlayEl = document.getElementById("flow-batch-overlay");
    }

    if (overlayEl) {
      overlayEl.style.cssText = "position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0, 0, 0, 0.75) !important; backdrop-filter: blur(12px) !important; z-index: 2147483640 !important; display: flex !important; align-items: center !important; justify-content: center !important; opacity: 1 !important; pointer-events: auto !important;";
      overlayEl.classList.add("active");
    }

    const panel = document.getElementById("flow-batch-panel");
    if (panel) {
      panel.style.cssText = "width: 92vw !important; height: 88vh !important; max-width: 1400px !important; background: #121216 !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; border-radius: 20px !important; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8) !important; display: flex !important; flex-direction: column !important; color: #f3f4f6 !important; overflow: hidden !important; z-index: 2147483641 !important; pointer-events: auto !important;";
    }

    try {
      await loadState();
    } catch (e) {
      console.warn("[FlowUI] 读取状态异常:", e);
    }
    
    // 安全同步设置项输入框
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined) el.value = val;
    };
    setVal("cfg-interval", state.settings.interval);
    setVal("cfg-random", state.settings.intervalRandom);
    setVal("cfg-max4s", state.settings.maxLetterFor4s);
    setVal("cfg-max6s", state.settings.maxLetterFor6s);
    setVal("cfg-aspect", state.settings.aspectRatio || "ASPECT_RATIO_9_16");
    setVal("cfg-model", state.settings.videoModel || "VIDEO_REFERENCES");
    setVal("cfg-resolution", state.settings.resolution || "VIDEO_RESOLUTION_720P");
    setVal("cfg-footagetype", state.settings.footageType || "VIDEO_FRAMES");
    
    try {
      renderTable();
    } catch (e) {
      console.warn("[FlowUI] 渲染任务表异常:", e);
    }
    try {
      renderPresetsList();
    } catch (e) {
      console.warn("[FlowUI] 渲染模板列表异常:", e);
    }
  }

  function closePanel() {
    if (!overlayEl) overlayEl = document.getElementById("flow-batch-overlay");
    if (overlayEl) {
      overlayEl.style.cssText = "display: none !important; opacity: 0 !important; pointer-events: none !important;";
      overlayEl.classList.remove("active");
    }
  }

  function openImportDialog() {
    if (!importDialogEl) importDialogEl = document.getElementById("flow-import-dialog");
    if (importDialogEl) {
      importDialogEl.style.cssText = "position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0, 0, 0, 0.75) !important; backdrop-filter: blur(12px) !important; z-index: 2147483647 !important; display: flex !important; align-items: center !important; justify-content: center !important; opacity: 1 !important; pointer-events: auto !important;";
      importDialogEl.classList.add("active");
    }
    const txt = document.getElementById("flow-import-textarea");
    if (txt) txt.value = "";
  }

  function closeImportDialog() {
    if (!importDialogEl) importDialogEl = document.getElementById("flow-import-dialog");
    if (importDialogEl) {
      importDialogEl.style.cssText = "display: none !important; opacity: 0 !important; pointer-events: none !important;";
      importDialogEl.classList.remove("active");
    }
  }

  function bindSettingsEvents() {
    const syncSetting = (elementId, settingKey) => {
      const el = document.getElementById(elementId);
      if (el) {
        el.addEventListener("change", (e) => {
          state.settings[settingKey] = parseInt(e.target.value, 10) || state.settings[settingKey];
          saveState();
        });
      }
    };

    syncSetting("cfg-interval", "interval");
    syncSetting("cfg-random", "intervalRandom");
    syncSetting("cfg-max4s", "maxLetterFor4s");
    syncSetting("cfg-max6s", "maxLetterFor6s");

    const syncSelect = (elementId, settingKey) => {
      const el = document.getElementById(elementId);
      if (el) {
        el.addEventListener("change", (e) => {
          state.settings[settingKey] = e.target.value;
          saveState();
        });
      }
    };

    syncSelect("cfg-aspect", "aspectRatio");
    syncSelect("cfg-model", "videoModel");
    syncSelect("cfg-resolution", "resolution");
    syncSelect("cfg-footagetype", "footageType");

    document.getElementById("btn-add-preset").addEventListener("click", () => {
      const name = prompt("请输入模板名称:");
      if (!name) return;
      const content = prompt("请输入模板内容（在要插入提示词的位置，用两个回车/换行符隔开）");
      if (content === null) return;
      state.presets.push({ name, content });
      saveState();
      renderPresetsList();
      renderTable();
    });
  }

  function renderPresetsList() {
    const container = document.getElementById("presets-list-container");
    if (!container) return;
    container.replaceChildren();
    state.presets.forEach((preset, index) => {
      const item = document.createElement("div");
      item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:6px 12px; border-radius:6px; border:1px solid var(--flow-border-glass);";
      setSafeHTML(item, `
        <span style="font-size:12px; font-weight:500;">${preset.name}</span>
        <button class="flow-btn secondary" style="font-size:10px; padding:4px 8px; color:#ef4444; border-color:rgba(239,68,68,0.2);" data-idx="${index}">删除</button>
      `);
      item.querySelector("button").addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        if (confirm(`确定删除模板 "${state.presets[idx].name}" 吗？`)) {
          state.presets.splice(idx, 1);
          saveState();
          renderPresetsList();
          renderTable();
        }
      });
      container.appendChild(item);
    });
  }

  // ----------------------------------------------------
  // 4. 加载页面图片
  // ----------------------------------------------------
  // 检查是否为 Google Flow 系统按钮/热键图标文字（排除取消收藏、更多选项等噪声）
  function isSystemHotbarLabel(text) {
    if (!text || typeof text !== "string") return true;
    const t = text.trim().toLowerCase();
    return t === "取消收藏" || t === "收藏" || t === "更多选项" || t === "favorite" || 
           t === "more_vert" || t === "image" || t === "play_circle" || t === "download" || 
           t === "显示用户图片的图块" || t === "图块" || t === "unfavorite" || t === "more options";
  }

  // 精准提取媒体图块标题名称
  function extractTileDisplayName(container, imgEl) {
    if (!container) return "";
    
    // 1. 最优先：明确的卡片标题元素（Google Flow 底部浮层文件名）
    const titleEl = typeof container.querySelector === "function" ? container.querySelector(".footer-title, .tile-name, .tile-title, input.editable-text-input, [data-tile-title]") : null;
    if (titleEl) {
      const val = titleEl.value || titleEl.textContent?.trim();
      if (val && !isSystemHotbarLabel(val)) return val;
    }

    // 2. 宿主卡片的 aria-label（Google Flow 顶层容器通常带有完整文件名）
    const card = (typeof container.closest === "function" ? container.closest("flow-grid-tile-container, [data-tile-id], flow-tile, flow-media-tile") : null) || container;
    const cardAria = card?.getAttribute?.("aria-label") || container.getAttribute?.("aria-label");
    if (cardAria && !isSystemHotbarLabel(cardAria)) {
      return cardAria.trim();
    }

    // 3. footer-left 区域（移除 mat-icon 等图标后的纯文件名）
    const footerLeft = typeof container.querySelector === "function" ? container.querySelector(".footer-left, .hover-footer, flow-tile-hover-footer") : null;
    if (footerLeft) {
      if (typeof footerLeft.cloneNode === "function") {
        const clone = footerLeft.cloneNode(true);
        if (typeof clone.querySelectorAll === "function") {
          clone.querySelectorAll("mat-icon, svg, button").forEach(el => el.remove());
        }
        const val = clone.textContent?.trim();
        if (val && !isSystemHotbarLabel(val)) return val;
      } else {
        const val = footerLeft.textContent?.trim();
        if (val && !isSystemHotbarLabel(val)) return val;
      }
    }

    // 4. 卡片的 title 属性
    const cardTitle = card?.getAttribute?.("title") || container.getAttribute?.("title");
    if (cardTitle && !isSystemHotbarLabel(cardTitle)) return cardTitle.trim();

    // 5. 图片自身属性
    if (imgEl) {
      const imgTitle = imgEl.getAttribute?.("title") || imgEl.getAttribute?.("aria-label");
      if (imgTitle && !isSystemHotbarLabel(imgTitle)) return imgTitle.trim();
      if (imgEl.alt && !isSystemHotbarLabel(imgEl.alt)) {
        return imgEl.alt.trim();
      }
    }

    return "";
  }

  // 深度归一化图名辅助器
  function normalizeNameHelper(name) {
    if (!name || typeof name !== "string") return "";
    return name
      .toLowerCase()
      // 全角转半角 (如 （1） 转为 (1) )
      .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      // 去除文件扩展名
      .replace(/\.(jpeg|jpg|png|webp|gif|bmp|mp4|mov)$/i, "")
      // 统一符号为空格
      .replace(/[()[\]{}（）【】_.\-\s]+/g, " ")
      .trim();
  }

  function cleanCompactName(name) {
    return normalizeNameHelper(name).replace(/\s+/g, "");
  }

  function extractSequenceIndex(name) {
    if (!name) return null;
    const norm = String(name).replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    const m = norm.match(/(?:[(_\-\s]|^)(\d{1,3})(?:[)_\-\s]|\.\w+$|$)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // 智能图名比对判定器（完全支持各种日期、格式、括号、序号、前后缀差异）
  function isImageNameMatch(targetName, pageName) {
    if (!targetName || !pageName) return false;

    const targetClean = cleanCompactName(targetName);
    const pageClean = cleanCompactName(pageName);

    if (!targetClean || !pageClean) return false;

    // 1. 紧凑形式完全一致
    if (targetClean === pageClean) return true;

    // 2. 检查序号一致性：若两者都有序号，但序号不相等，则严禁匹配！（例如 (3) 绝对不匹配 (6)）
    const targetSeq = extractSequenceIndex(targetName);
    const pageSeq = extractSequenceIndex(pageName);
    if (targetSeq !== null && pageSeq !== null && targetSeq !== pageSeq) {
      return false;
    }

    // 3. 包含匹配（且序号必须一致）
    if (targetClean.includes(pageClean) || pageClean.includes(targetClean)) {
      if (targetSeq !== null && pageSeq !== null) {
        return targetSeq === pageSeq;
      }
      return true;
    }

    // 4. 标准分词重叠匹配（去掉纯数字后关键词有交集）
    const targetNorm = normalizeNameHelper(targetName);
    const pageNorm = normalizeNameHelper(pageName);
    const targetWords = targetNorm.split(" ").filter(w => w.length >= 2 && !/^\d+$/.test(w));
    const pageWords = pageNorm.split(" ").filter(w => w.length >= 2 && !/^\d+$/.test(w));

    if (targetWords.length > 0 && pageWords.length > 0) {
      const hasCommon = targetWords.some(tw => pageWords.some(pw => tw.includes(pw) || pw.includes(tw)));
      if (hasCommon) {
        if (targetSeq !== null && pageSeq !== null) {
          return targetSeq === pageSeq;
        }
        return true;
      }
    }

    return false;
  }

  // 获取当前 Flow 合集/项目页面的所有已上传素材列表
  function getLoadedPageImages() {
    const images = [];
    const seenIds = new Set();

    // 1. 优先从所有图块容器中扫描
    const candidateContainers = document.querySelectorAll(
      "flow-grid-tile-container, " +
      "flow-image-tile, " +
      "flow-tile, " +
      "flow-media-tile, " +
      ".virtual-item-container:has(img), " +
      "[data-tile-id]"
    );

    candidateContainers.forEach((container, idx) => {
      const img = container.querySelector("img");
      if (!img) return;
      const src = img.src || img.getAttribute("src") || "";
      if (!src || src.includes("avatar") || src.includes("favicon") || src.includes("googlelogo") || src.startsWith("data:image/svg") || img.closest(".gb_X, .gbii")) return;

      const displayName = extractTileDisplayName(container, img) || `素材图片_${idx + 1}`;
      const mediaId = img.getAttribute("data-media-id") || container.dataset?.tileId || container.closest("[data-tile-id]")?.dataset?.tileId;
      const nameMatch = src.match(/name=([0-9a-zA-Z_-]+)/) || src.match(/\/([0-9a-fA-F-]{36})/) || src.match(/key=([^&]+)/);
      const uniqueId = mediaId || (nameMatch ? nameMatch[1] : `img_${idx}_${src.substring(src.length - 16)}`);

      if (!seenIds.has(uniqueId)) {
        seenIds.add(uniqueId);
        images.push({
          id: uniqueId,
          primaryMediaKey: uniqueId,
          displayName: displayName,
          src: src
        });
      }
    });

    // 2. 降级兜底：扫描全局 img 元素
    if (!images.length) {
      document.querySelectorAll("flow-project-page img, cdk-virtual-scroll-viewport img, .tiles-container img, .virtual-scroll-container img").forEach((img, idx) => {
        const src = img.src || "";
        if (!src || src.startsWith("data:image/svg") || src.includes(".svg") || src.includes("googlelogo") || src.includes("avatar") || src.includes("favicon") || src.includes("gb_")) return;
        const card = img.closest("flow-grid-tile-container, [data-tile-id], mat-card, div") || img.parentElement;
        const displayName = extractTileDisplayName(card, img) || `页面素材_${idx + 1}`;
        const uniqueId = `img_fallback_${idx}`;
        if (!seenIds.has(uniqueId)) {
          seenIds.add(uniqueId);
          images.push({
            id: uniqueId,
            primaryMediaKey: uniqueId,
            displayName: displayName,
            src: src
          });
        }
      });
    }

    console.log(`[FlowUI] 读取到页面素材图片共 ${images.length} 张:`, images);
    return images;
  }

  function loadPageImages() {
    const images = getLoadedPageImages();
    if (!images.length) {
      showToast("页面暂未识别到候选素材图片。请确认项目已有素材，或直接点击“导入外部配置”粘贴任务。");
      return;
    }

    // 对当前任务列表中未关联到缩略图的任务进行自动匹配补齐
    let autoResolvedCount = 0;
    state.tasks.forEach(task => {
      if (!task.image?.src) {
        const taskName = task.image?.displayName || "";
        const localName = getFilenameFromPath(task.image?.localImagePath || task.local_image_path);
        const matched = images.find(img => 
          (taskName && isImageNameMatch(taskName, img.displayName)) || 
          (localName && isImageNameMatch(localName, img.displayName))
        );
        if (matched) {
          task.image = {
            ...matched,
            src: matched.src,
            displayName: task.image?.displayName || matched.displayName,
            localImagePath: task.image?.localImagePath || task.local_image_path
          };
          autoResolvedCount++;
        }
      }
    });

    const addedImageIds = new Set(state.tasks.map(t => t.image?.id).filter(Boolean));
    const newTasks = [];

    images.forEach(img => {
      if (!addedImageIds.has(img.id)) {
        newTasks.push({
          image: img,
          text: "",
          preset: state.presets[0]?.name || "无模版(直接填入)",
          footageType: state.settings.footageType,
          count: state.settings.defaultCount,
          status: [],
          message: [],
          downloaded: [],
          download_path: ""
        });
      }
    });

    if (newTasks.length > 0 || autoResolvedCount > 0) {
      if (newTasks.length > 0) state.tasks = [...state.tasks, ...newTasks];
      renderTable();
      saveState();
      showToast(`加载成功！新增 ${newTasks.length} 个任务，自动补全 ${autoResolvedCount} 个已有任务图块`);
    } else {
      showToast(`页面识别到 ${images.length} 张图片，任务列表已为最新`);
    }
  }

  // ----------------------------------------------------
  // 5. 对接导入解析与闭环报告导出
  // ----------------------------------------------------
  
  // 截取本地路径中的文件名
  function getFilenameFromPath(filePath) {
    if (!filePath) return "";
    const cleanPath = filePath.replace(/\\/g, "/");
    return cleanPath.substring(cleanPath.lastIndexOf("/") + 1);
  }

  function normalizeDuration(value, fallback = null) {
    if (value == null || value === "") return fallback;
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(?:s|秒|seconds?)?$/i);
    const seconds = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`无效的视频秒数: ${value}`);
    return seconds;
  }

  // 手动解析 JSON 数据对接导入
  function handleJSONImport() {
    const rawVal = document.getElementById("flow-import-textarea").value.trim();
    if (!rawVal) {
      alert("内容为空！");
      return;
    }

    let parsedList = [];
    try {
      parsedList = JSON.parse(rawVal);
      if (!Array.isArray(parsedList)) {
        alert("导入数据格式错误！必须为 JSON 数组格式（由 [ 和 ] 包裹）。");
        return;
      }
    } catch (e) {
      alert(`JSON 解析失败，请检查格式！\n错误详情: ${e.message}`);
      return;
    }

    try {
      parsedList.forEach((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 项不是任务对象`);
        item.duration = normalizeDuration(item.duration ?? item.duration_seconds ?? item.durationSeconds, 6);
      });
    } catch (err) { alert(`导入失败：${err.message}`); return; }
    const loadedImages = getLoadedPageImages();
    console.log("[FlowUI] 正在导入 JSON，当前页面识别到的图片列表为:", loadedImages);
    
    let importCount = 0;

    parsedList.forEach(item => {
      const prompt = item.prompt || item.text || "";
      const mode = item.mode || item.footageType || "VIDEO_FRAMES";
      const duration = item.duration;
      const downloadPath = item.download_path || item.downloadPath || "";
      const imageName = item.image_name || item.imageName || item.displayName || item.name || "";
      const localImagePath = item.local_image_path || item.localImagePath || item.path || "";
      const localFileName = getFilenameFromPath(localImagePath);
      // 支持直接在 JSON 中传入网络图片或 Base64 DataURL
      const incomingSrc = item.image_url || item.imageUrl || item.src || item.image_src || item.base64 || item.image_base64 || item.dataUrl || "";

      // 图片查找匹配逻辑：采用多维度智能图名比对 (归一化、中英文括号、序号一致性、关键词交集)
      let matchedImg = null;
      if (imageName || localFileName) {
        matchedImg = loadedImages.find(img => {
          return (imageName && isImageNameMatch(imageName, img.displayName)) ||
                 (localFileName && isImageNameMatch(localFileName, img.displayName));
        });
      }

      console.log("[FlowUI] 匹配比对详情:", {
        输入图名: imageName,
        输入本地路径: localImagePath,
        匹配目标清理: { targetName: cleanCompactName(imageName), targetLocalName: cleanCompactName(localFileName) },
        匹配结果: matchedImg ? matchedImg.displayName : "未在页面即时找到"
      });

      const finalDisplayName = imageName || localFileName || (matchedImg ? matchedImg.displayName : "未命名素材");
      let finalTaskImage = null;

      if (matchedImg) {
        finalTaskImage = {
          ...matchedImg,
          src: matchedImg.src || incomingSrc,
          displayName: matchedImg.displayName || finalDisplayName,
          localImagePath: localImagePath
        };
      } else {
        finalTaskImage = {
          id: null,
          primaryMediaKey: null,
          displayName: finalDisplayName,
          src: incomingSrc,
          localImagePath: localImagePath
        };
      }

      // 关键！状态一律初始化为 pending 就绪态，绝不导入时判为 failed 错误！
      const linesCount = splitTextToLines(prompt).length || 1;
      const statusList = new Array(linesCount).fill("pending");
      const messageList = new Array(linesCount).fill("等待批量调度");

      // 提取 JSON 中可能指定的独立比例、分辨率和模型 (具备智能归一化)
      const rawAspect = item.aspect_ratio || item.aspectRatio || "";
      let taskAspect = state.settings.aspectRatio;
      if (rawAspect.includes("9:16") || rawAspect.includes("9_16") || String(rawAspect).toUpperCase().includes("PORTRAIT")) {
        taskAspect = "ASPECT_RATIO_9_16";
      } else if (rawAspect.includes("1:1") || rawAspect.includes("1_1") || String(rawAspect).toUpperCase().includes("SQUARE")) {
        taskAspect = "ASPECT_RATIO_1_1";
      } else if (rawAspect.includes("16:9") || rawAspect.includes("16_9") || String(rawAspect).toUpperCase().includes("LANDSCAPE")) {
        taskAspect = "ASPECT_RATIO_16_9";
      }

      const rawRes = item.resolution || item.video_resolution || "";
      let taskRes = state.settings.resolution;
      if (String(rawRes).includes("360")) taskRes = "VIDEO_RESOLUTION_360P";
      else if (String(rawRes).includes("1080")) taskRes = "VIDEO_RESOLUTION_1080P";
      else if (String(rawRes).includes("720")) taskRes = "VIDEO_RESOLUTION_720P";

      const rawModel = item.model || item.video_model || "";
      let taskModel = state.settings.videoModel;
      if (String(rawModel).includes("3_1") || String(rawModel).toLowerCase().includes("lite")) taskModel = "veo_3_1_lite_low_priority";
      else if (String(rawModel).toLowerCase().includes("fast")) taskModel = "veo_fast";
      else if (String(rawModel).includes("veo_2") || String(rawModel).includes("veo2")) taskModel = "veo_2";

      state.tasks.push({
        image: finalTaskImage,
        text: prompt,
        preset: "无模版(直接填入)",
        footageType: mode,
        count: item.count || 1,
        status: statusList,
        message: messageList,
        downloaded: new Array(linesCount).fill(false),
        download_path: downloadPath,
        duration: duration,
        aspectRatio: taskAspect,
        resolution: taskRes,
        videoModel: taskModel
      });
      importCount++;
    });

    closeImportDialog();
    renderTable();
    saveState();
    
    showToast(`导入成功！已加入 ${importCount} 个任务配置`);
  }

  // 复制执行报告（供 Python 读取剪贴板，一键归位）
  function copyExecutionReport() {
    if (!state.tasks.length) {
      alert("当前任务列表为空，无可导出的报告。");
      return;
    }

    const report = state.tasks.map(task => {
      // 合并状态 (因为页面支持分行，导入只对应单条绝对路径，直接去 status[0])
      return {
        prompt: task.text,
        image_name: task.image.displayName,
        download_path: task.download_path,
        duration: task.duration ?? null,
        status: task.status[0] || "pending",
        message: task.message[0] || ""
      };
    });

    try {
      const jsonStr = JSON.stringify(report, null, 2);
      navigator.clipboard.writeText(jsonStr).then(() => {
        alert("执行报告 JSON 已成功复制到系统剪贴板！\n请回到您的 Python 客户端软件中读取并点击“剪切归位”按钮。");
      }).catch(err => {
        alert("复制剪贴板失败，请手动在控制台查看。");
        console.log("[Execution Report]", jsonStr);
      });
    } catch (e) {
      alert("导出错误: " + e.message);
    }
  }

  // ----------------------------------------------------
  // 6. 任务表格渲染
  // ----------------------------------------------------
  function renderTable() {
    const tbody = document.querySelector("#flow-tasks-table tbody");
    if (!tbody) return;
    tbody.replaceChildren();

    // 自动对任务列表中没有预览图的任务尝试结合页面图片进行关联补全
    const pageImages = getLoadedPageImages();
    if (pageImages.length > 0) {
      state.tasks.forEach(task => {
        if (!task.image?.src) {
          const taskName = task.image?.displayName || "";
          const localName = getFilenameFromPath(task.image?.localImagePath || task.local_image_path);
          const matched = pageImages.find(img => 
            (taskName && isImageNameMatch(taskName, img.displayName)) || 
            (localName && isImageNameMatch(localName, img.displayName))
          );
          if (matched) {
            task.image = {
              ...matched,
              src: matched.src,
              displayName: task.image?.displayName || matched.displayName,
              localImagePath: task.image?.localImagePath || task.local_image_path
            };
          }
        }
      });
    }

    if (!state.tasks.length) {
      setSafeHTML(tbody, `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--flow-text-secondary); padding: 40px 0;">
            暂无任务。请点击“导入外部 JSON”粘贴任务数据，或点击“加载页面图片”直接导入当前网页上的原料。
          </td>
        </tr>
      `);
      return;
    }

    state.tasks.forEach((task, rowIndex) => {
      const tr = document.createElement("tr");
      
      // 1. 图片预览与名称展示列
      const imgTd = document.createElement("td");
      imgTd.style.width = "115px";
      imgTd.style.textAlign = "center";
      
      const imgPreviewSrc = task.image?.src || (task.image?.primaryMediaKey?.startsWith("http") ? task.image.primaryMediaKey : "");
      const taskDisplayName = task.image?.displayName || "未命名素材";

      if (imgPreviewSrc) {
        setSafeHTML(imgTd, `
          <div class="cell-image-container" title="点击可更换本地图片预览" data-row="${rowIndex}">
            <div class="cell-image-box has-image">
              <img class="cell-image-preview" src="${imgPreviewSrc}" alt="预览" />
              <div class="cell-image-hover-mask">更换</div>
            </div>
            <span class="cell-image-name" title="${taskDisplayName}">${taskDisplayName}</span>
          </div>
        `);
      } else {
        setSafeHTML(imgTd, `
          <div class="cell-image-container" title="未关联图像，点击可直接选择本地图片预览" data-row="${rowIndex}">
            <div class="cell-image-box no-image">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              <span class="cell-image-pick-text">选图</span>
            </div>
            <span class="cell-image-name" title="${taskDisplayName}">${taskDisplayName}</span>
          </div>
        `);
      }

      // 绑定点击本地选图/换图预览功能
      const imgContainer = imgTd.querySelector(".cell-image-container");
      if (imgContainer) {
        imgContainer.addEventListener("click", () => {
          const fileInput = document.createElement("input");
          fileInput.type = "file";
          fileInput.accept = "image/*";
          fileInput.style.setProperty("display", "none", "important");
          fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = (loadEvt) => {
                if (!task.image) task.image = {};
                task.image.src = loadEvt.target.result;
                if (!task.image.displayName || task.image.displayName === "未命名素材" || task.image.displayName.startsWith("素材图片_")) {
                  task.image.displayName = file.name;
                }
                saveState();
                renderTable();
                showToast(`已成功为任务加载图片: ${file.name}`);
              };
              reader.readAsDataURL(file);
            }
          };
          document.body.appendChild(fileInput);
          fileInput.click();
          fileInput.remove();
        });
      }
      tr.appendChild(imgTd);

      // 2. 文本输入列
      const textTd = document.createElement("td");
      const textarea = document.createElement("textarea");
      textarea.className = "cell-textarea";
      textarea.value = task.text;
      textarea.placeholder = "分行输入提示词...";
      textarea.addEventListener("change", (e) => {
        task.text = e.target.value;
        const linesCount = splitTextToLines(task.text).length;
        task.status = extendArray(task.status, linesCount, "pending");
        task.message = extendArray(task.message, linesCount, "");
        task.downloaded = extendArray(task.downloaded, linesCount, false);
        saveState();
        renderTableStatusCell(tr, task, rowIndex);
      });
      textTd.appendChild(textarea);
      tr.appendChild(textTd);

      // 3. 模版下拉列
      const presetTd = document.createElement("td");
      const presetSelect = document.createElement("select");
      presetSelect.className = "cell-select";
      state.presets.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.innerText = p.name;
        presetSelect.appendChild(opt);
      });
      presetSelect.value = task.preset || "无模版(直接填入)";
      presetSelect.addEventListener("change", (e) => {
        task.preset = e.target.value;
        saveState();
      });
      presetTd.appendChild(presetSelect);
      tr.appendChild(presetTd);

      // 4. 素材类型列
      const typeTd = document.createElement("td");
      const typeSelect = document.createElement("select");
      typeSelect.className = "cell-select";
      setSafeHTML(typeSelect, `
        <option value="VIDEO_FRAMES">帧模式 (默认)</option>
        <option value="VIDEO_REFERENCES">素材模式</option>
      `);
      typeSelect.value = task.footageType;
      typeSelect.addEventListener("change", (e) => {
        task.footageType = e.target.value;
        saveState();
      });
      typeTd.appendChild(typeSelect);
      tr.appendChild(typeTd);

      const durationTd = document.createElement("td");
      const durationInput = document.createElement("input");
      durationInput.type = "number";
      durationInput.min = "0.1";
      durationInput.step = "any";
      durationInput.className = "cell-select";
      durationInput.style.width = "70px";
      durationInput.value = task.duration ?? "";
      durationInput.placeholder = "自动";
      durationInput.title = "按此秒数提交；当前 Flow 模型不支持时会报错";
      durationInput.addEventListener("change", () => {
        try { task.duration = normalizeDuration(durationInput.value); saveState(); }
        catch (err) { showToast(err.message); durationInput.value = task.duration ?? ""; }
      });
      durationTd.appendChild(durationInput);
      tr.appendChild(durationTd);

      // 5. 生成数数量列
      const countTd = document.createElement("td");
      const countSelect = document.createElement("select");
      countSelect.className = "cell-select";
      countSelect.style.width = "60px";
      countSelect.style.minWidth = "60px";
      [1, 2, 3, 4].forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.innerText = v;
        countSelect.appendChild(opt);
      });
      countSelect.value = task.count;
      countSelect.addEventListener("change", (e) => {
        task.count = parseInt(e.target.value, 10);
        saveState();
      });
      countTd.appendChild(countSelect);
      tr.appendChild(countTd);

      // 6. 状态与日志列
      const statusTd = document.createElement("td");
      statusTd.className = "status-cell-container";
      tr.appendChild(statusTd);
      renderTableStatusCell(tr, task, rowIndex);

      // 7. 操作列 (单项运行 + 删除)
      const actionTd = document.createElement("td");
      actionTd.style.textAlign = "center";
      actionTd.style.width = "125px";
      actionTd.style.whiteSpace = "nowrap";

      const runBtn = document.createElement("button");
      runBtn.className = "flow-btn primary";
      runBtn.style.cssText = "padding: 3px 8px; font-size: 11px; margin-right: 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px; background: #10b981; border: none; color: #fff; cursor: pointer;";
      runBtn.title = "仅运行当前这一项任务，生成并下载完毕后即停止";
      setSafeHTML(runBtn, `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        <span>单跑</span>
      `);
      runBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (batchPromise) {
          showToast("已有生成队列正在执行中，请先停止后再启动");
          return;
        }
        startBatch(rowIndex);
      });
      actionTd.appendChild(runBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "cell-btn-delete";
      delBtn.title = "单独删除此项任务配置";
      setSafeHTML(delBtn, `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        <span>删除</span>
      `);
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (batchPromise && rowIndex === state.currentIndex) {
          showToast("当前任务正在生成中，请先停止队列再删除该任务");
          return;
        }
        const taskName = task.image?.displayName || `任务 #${rowIndex + 1}`;
        if (state.currentIndex > rowIndex) {
          state.currentIndex--;
        } else if (state.currentIndex === rowIndex) {
          state.currentLineIndex = 0;
        }
        state.tasks.splice(rowIndex, 1);
        renderTable();
        saveState();
        showToast(`已删除任务: ${taskName}`);
      });
      actionTd.appendChild(delBtn);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });
  }

  function renderTableStatusCell(rowElement, task, rowIndex) {
    const container = rowElement.querySelector(".status-cell-container");
    if (!container) return;
    
    container.replaceChildren();
    const lines = splitTextToLines(task.text);
    
    if (lines.length === 0) {
      setSafeHTML(container, `<span style="color: var(--flow-text-secondary); font-size:12px;">待输入文本</span>`);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex; flex-direction:column; gap:6px; max-height:86px; overflow-y:auto; padding-right:4px;";
    
    lines.forEach((line, lineIdx) => {
      const status = task.status[lineIdx] || "pending";
      const message = task.message[lineIdx] || "";
      
      const lineRow = document.createElement("div");
      lineRow.className = "status-line-row";
      
      let badgeHtml = "";
      if (status === "pending") {
        badgeHtml = `<span class="status-badge pending"><span style="width:6px; height:6px; border-radius:50%; background:#f59e0b; display:inline-block; box-shadow:0 0 6px #f59e0b; flex-shrink:0;"></span>等待</span>`;
      } else if (status === "generating") {
        badgeHtml = `<span class="status-badge generating"><span class="spinner"></span>生成中</span>`;
      } else if (status === "success") {
        badgeHtml = `<span class="status-badge success">✓ 成功</span>`;
      } else if (status === "failed") {
        badgeHtml = `<span class="status-badge failed" title="${message}">✗ 失败</span>`;
      }

      setSafeHTML(lineRow, `
        <span class="status-line-text" title="${line}">#${lineIdx+1}: ${line}</span>
        <div class="status-line-actions">
          ${badgeHtml}
          ${status !== "pending" && status !== "generating" ? `
            <button class="flow-btn secondary btn-line-reset" data-line="${lineIdx}">${task.mediaBindings?.[lineIdx]?.schema === 2 && status === "failed" ? "重试下载" : "重置"}</button>
          ` : ""}
        </div>
      `);

      // 绑定行重置功能
      const resetBtn = lineRow.querySelector(".btn-line-reset");
      if (resetBtn) {
        resetBtn.addEventListener("click", (e) => {
          const lIdx = parseInt(e.currentTarget.dataset.line, 10);
          const previousStatus = task.status[lIdx];
          task.status[lIdx] = "pending";
          const retryDownload = previousStatus !== "success" && task.mediaBindings?.[lIdx]?.schema === 2;
          task.message[lIdx] = retryDownload ? "等待重新下载已生成的视频" : "已重置等待生成";
          task.downloaded[lIdx] = false;
          if (!retryDownload && task.videoUrls) task.videoUrls[lIdx] = null;
          if (!retryDownload && task.downloadIds) task.downloadIds[lIdx] = null;
          if (!retryDownload && task.mediaBindings) task.mediaBindings[lIdx] = null;
          saveState();
          renderTableStatusCell(rowElement, task, rowIndex);
          if (retryDownload) startBatch();
        });
      }

      wrapper.appendChild(lineRow);
    });

    container.appendChild(wrapper);
  }

  // ----------------------------------------------------
  // 7. 后台防休眠保活引擎与页面遮罩清理
  // ----------------------------------------------------
  let keepAliveAudioCtx = null;
  let keepAliveOsc = null;

  function enableTabKeepAlive() {
    try {
      if (!keepAliveAudioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          keepAliveAudioCtx = new AudioCtxClass();
          keepAliveOsc = keepAliveAudioCtx.createOscillator();
          const gain = keepAliveAudioCtx.createGain();
          gain.gain.value = 0.00001; // 人耳绝对静音 (几乎为 0)
          keepAliveOsc.connect(gain);
          gain.connect(keepAliveAudioCtx.destination);
          keepAliveOsc.start();
          if (keepAliveAudioCtx.state === "suspended") {
            keepAliveAudioCtx.resume();
          }
          console.log("[FlowUI] 已激活后台防休眠引擎，Chrome 将以最高优先级持续执行后台任务！");
        }
      } else if (keepAliveAudioCtx.state === "suspended") {
        keepAliveAudioCtx.resume();
      }
    } catch (e) {
      console.warn("[FlowUI] 启用音频防休眠提示:", e);
    }
  }

  function disableTabKeepAlive() {
    try {
      if (keepAliveOsc) {
        keepAliveOsc.stop();
        keepAliveOsc.disconnect();
        keepAliveOsc = null;
      }
      if (keepAliveAudioCtx) {
        keepAliveAudioCtx.close();
        keepAliveAudioCtx = null;
      }
      console.log("[FlowUI] 已停用后台防休眠引擎");
    } catch (e) {}
  }

  // 清理 Flow 页面上的历史弹窗、菜单、全屏预览与 backdrop，保证操作视口清空
  async function cleanupPageOverlays() {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      const backdrops = document.querySelectorAll(".cdk-overlay-backdrop");
      backdrops.forEach(bd => {
        try { bd.click(); } catch (_) {}
      });

      // 若意外打开了素材/大图详情面板，自动点击返回或关闭按钮退出大图模式
      const detailExitBtn = document.querySelector("button[aria-label='返回'], button[aria-label='Back'], button[aria-label='关闭'], button[aria-label='Close'], .asset-detail-back, flow-asset-detail button:first-child");
      if (detailExitBtn && !detailExitBtn.disabled) {
        console.log("[FlowUI] 检测到大图/素材详情面板，自动点击退出");
        try { detailExitBtn.click(); } catch (_) {}
      }

      const mainContainer = document.querySelector("flow-project-page, .project-container, body");
      if (mainContainer) {
        mainContainer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await delay(200);
    } catch (e) {
      console.warn("[FlowUI] 清理页面遮罩提示:", e);
    }
  }

  let isStopRequested = false;

  let batchPromise = null;
  function startBatch(singleRowIndex = null) {
    if (batchPromise) return batchPromise;
    isStopRequested = false;
    document.querySelectorAll("#flow-tasks-table input, #flow-tasks-table textarea, #flow-tasks-table select, #flow-tasks-table button").forEach(el => el.disabled = true);
    document.getElementById("btn-start-batch")?.style.setProperty("display", "none", "important");
    document.getElementById("btn-stop-batch")?.style.setProperty("display", "inline-flex", "important");
    batchPromise = runBatch(singleRowIndex).catch(err => {
      console.error("[Batch] 队列异常", err);
      showToast(`队列停止：${err.message}`, 6000);
    }).finally(() => {
      onBatchFinished();
      document.querySelectorAll("#flow-tasks-table input, #flow-tasks-table textarea, #flow-tasks-table select, #flow-tasks-table button").forEach(el => el.disabled = false);
      batchPromise = null;
    });
    return batchPromise;
  }

  async function runBatch(singleRowIndex = null) {
    state.isSuspended = false;
    if (alarmDialogEl) alarmDialogEl.style.setProperty("display", "none", "important");
    if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
    
    // 激活后台防休眠引擎，保证失焦/后台平稳高频运行
    enableTabKeepAlive();

    // 启动安全限制监测
    startActivityCheck();

    // 校验页面生成组件是否就绪 (ProseMirror 富文本框与生成按钮)
    let editor = document.querySelector("flow-rich-text-editor div.ProseMirror") || document.querySelector("div.ProseMirror[contenteditable='true']");
    let genBtn = document.querySelector("flow-generate-icon-button button") || document.querySelector("button.generate-icon-button");

    if (!editor || !genBtn) {
      console.log("[FlowUI] 正在等待页面 ProseMirror 提示词框及生成按钮就绪...");
      for (let w = 0; w < 6; w++) {
        await delay(500);
        editor = document.querySelector("flow-rich-text-editor div.ProseMirror") || document.querySelector("div.ProseMirror[contenteditable='true']");
        genBtn = document.querySelector("flow-generate-icon-button button") || document.querySelector("button.generate-icon-button");
        if (editor && genBtn) break;
      }
    }

    if (!editor || !genBtn) {
      if (!location.href.includes("/project/")) {
        alert("请先进入具体的 Flow 项目页面 (例如 https://flow.google.com/project/...) 再启动批量生成！");
        return;
      }
      console.warn("[FlowUI] 提示词框或生成按钮未完全定位，将在执行时进行动态查找...");
    }

    const validTasks = state.tasks.filter(t => splitTextToLines(t.text).length > 0);
    if (!validTasks.length) {
      alert("无可执行生成任务！(任务列表为空或提示词未填)");
      return;
    }

    if (isStopRequested) return;
    state.isRunning = true;
    
    document.getElementById("btn-start-batch").style.setProperty("display", "none", "important");
    document.getElementById("btn-stop-batch").style.setProperty("display", "inline-flex", "important");
    
    const isSingle = singleRowIndex !== null && typeof singleRowIndex === "number";
    showToast(isSingle ? `开始执行单项任务 #${singleRowIndex + 1}...` : "开始自动化批量生成队列...");
    
    const intervalSec = state.settings.interval;
    const intervalRand = state.settings.intervalRandom;

    const startRow = isSingle ? singleRowIndex : (state.currentIndex || 0);
    const endRow = isSingle ? (singleRowIndex + 1) : state.tasks.length;

    // 读取存储中的断点索引继续运行，实现断点续跑
    for (let rIdx = startRow; rIdx < endRow; rIdx++) {
      state.currentIndex = rIdx;
      await saveState();

      const task = state.tasks[rIdx];
      const lines = splitTextToLines(task.text);
      if (!lines.length) continue;
      if (!task.image) task.image = { displayName: `任务_${rIdx + 1}`, primaryMediaKey: "" };

      for (let lIdx = state.currentLineIndex || 0; lIdx < lines.length; lIdx++) {
        state.currentLineIndex = lIdx;
        await saveState();

        if (isStopRequested) {
          showToast("用户中断了批量任务！");
          onBatchFinished();
          return;
        }

        // 跳过已经成功的行
        if (task.status[lIdx] === "success" || (Array.isArray(task.downloaded) && task.downloaded[lIdx])) continue;

        state.activeTasksQueue = [];
        state.taskRecord = {};
        window.currentProcess = null;
        document.querySelectorAll("video").forEach(v => {
          const src = v.getAttribute("src") || v.currentSrc || v.src;
          if (src) downloadedUrlsSet.add(src);
        });
        const lineText = lines[lIdx];
        // 允许单个任务有设定好的 duration，否则动态计算
        const duration = normalizeDuration(task.duration, calculateDuration(lineText));
        const preset = state.presets.find(p => p.name === task.preset);
        const parsedPreset = parsePreset(preset?.content);

        updateLineStatus(rIdx, lIdx, "pending", "排队准备提交...");
        
        let submitOk = false;
        if (task.mediaBindings?.[lIdx]?.schema === 2) {
          submitOk = await retrySavedVideo(task, rIdx, lIdx);
        }
        for (let subTry = 0; task.mediaBindings?.[lIdx]?.schema !== 2 && subTry < 2; subTry++) {
          try {
            if (isStopRequested) return;
            console.log(`[Batch] 自动提交: Row=${rIdx}, Line=${lIdx}, Text=${lineText}, Duration=${duration}`);
            
            await submitTaskToPage({
              image: task.image,
              lineText: lineText,
              presetBefore: parsedPreset.before,
              presetAfter: parsedPreset.after,
              footageType: task.footageType,
              count: task.count,
              duration: duration,
              rowIndex: rIdx,
              lineIndex: lIdx,
              download_path: task.download_path,
              resolution: task.resolution,
              aspectRatio: task.aspectRatio,
              videoModel: task.videoModel
            });

            if (!task.downloaded[lIdx] && !isStopRequested) updateLineStatus(rIdx, lIdx, "generating", "已提交到 Flow，等待对应媒体 ID 生成完成...");
            state.retryCount = 0;
            await saveState();
            submitOk = true;
            break;
            
          } catch (err) {
            console.error(`[Batch] 第 ${subTry + 1} 次提交触发异常:`, err);
            if (err.configurationError) {
              updateLineStatus(rIdx, lIdx, "failed", `未提交生成：${err.message}`);
              break;
            }
            if (subTry === 0) {
              updateLineStatus(rIdx, lIdx, "pending", `提交受阻: ${err.message}，正在等待 3 秒后重试...`);
              await delay(3000);
            } else {
              updateLineStatus(rIdx, lIdx, "failed", "提交失败: " + err.message);
              await saveState();
            }
          }
        }

        if (!submitOk) {
          console.warn(`[Batch] 任务 (Row=${rIdx}, Line=${lIdx}) 提交失败，自动流转至下一项`);
          continue;
        }

        // ====================================================
        // 核心等待逻辑：高精度状态检测 + 视频生成完毕后立刻自动下载 + 严格下载完成后再倒计时流转
        // ====================================================
        const maxWaitSec = Math.max(120, Number(state.settings.maxWaitTime) || 300);
        let waitedSec = 0;
        let isTaskCompleted = false;
        let downloadTriggered = false;
        const waitStartTime = Date.now();
        while ((Date.now() - waitStartTime) / 1000 < maxWaitSec) {
          if (isStopRequested) break;
          if (state.isSuspended) { await delay(500); continue; }

          const binding = task.mediaBindings?.[lIdx];
          console.log(`[Batch] ⏳ 等待中 (${Math.round(waitedSec)}s/${maxWaitSec}s): Row=${rIdx}, Line=${lIdx}, status=${task.status[lIdx]}, downloaded=${task.downloaded[lIdx]}, downloadId=${task.downloadIds?.[lIdx] || '无'}, mediaIds=${JSON.stringify(binding?.mediaIds || [])}, readyIds=${JSON.stringify(binding?.readyIds || [])}`);

          if (task.downloadIds?.[lIdx] && !task.downloaded[lIdx]) {
            console.log(`[Batch] 🔍 正在查询后台下载状态: downloadId=${task.downloadIds[lIdx]}...`);
            const downloadState = await sendToExtension("getDownloadStatus", { downloadId: task.downloadIds[lIdx] });
            console.log(`[Batch] 📥 后台下载状态返回: downloadId=${task.downloadIds[lIdx]}, state=${downloadState?.state}, error=${downloadState?.error || '无'}`);
            if (downloadState?.state === "complete") {
              task.downloaded[lIdx] = true;
              updateLineStatus(rIdx, lIdx, "success", "视频下载已完成");
            } else if (downloadState?.state === "interrupted") {
              updateLineStatus(rIdx, lIdx, "failed", `视频已生成，下载中断: ${downloadState.error || "未知原因"}。可重试下载。`);
            }
          }
          if (task.status[lIdx] === "failed") {
            console.warn(`[Batch] ⚠️ 当前行状态已为 failed，退出等待循环: Row=${rIdx}, Line=${lIdx}, message=${task.message[lIdx]}`);
            break;
          }
          // 1. 检查该任务行是否已经完成下载 (status 变为 success 或 downloaded[lIdx] 变为 true)
          if (task.status[lIdx] === "success" && (Array.isArray(task.downloaded) && task.downloaded[lIdx])) {
            isTaskCompleted = true;
            console.log(`[Batch] 任务已确认生成并下载成功！(Row=${rIdx}, Line=${lIdx}, 耗时=${Math.round(waitedSec)}s)`);
            break;
          }

          let isVideoGenerated = false;

          const boundMediaIds = binding?.mediaIds || [];
          const readyMediaIds = binding?.readyIds || [];

          // 2. 检查是否有已就绪的本任务媒体直链 (优先来自 flow-proxy RPC 拦截或 DOMWatcher)
          let targetVideoUrl = null;
          for (const mId of boundMediaIds) {
            if (binding.urls?.[mId]) {
              targetVideoUrl = binding.urls[mId];
              isVideoGenerated = true;
              console.log(`[Batch] 🎯 找到当前任务已绑定的直链 (mediaId=${mId}): ${targetVideoUrl.substring(0, 80)}`);
              break;
            }
          }

          // 3. 定位属于当前任务行的批次容器并悬停唤醒懒加载视频
          const targetBatchContainer = findCurrentBatchContainer(task, lIdx);
          const currentBatchTiles = targetBatchContainer ? 
            Array.from(targetBatchContainer.querySelectorAll("flow-video-tile")) : 
            Array.from(document.querySelectorAll("flow-video-tile"));

          if (currentBatchTiles.length > 0) {
            for (const tile of currentBatchTiles) {
              triggerTileHover(tile);
            }
          }

          // 4. 严格校验：只有视频 mediaId 明确匹配当前任务的 boundMediaIds 时，才认领为本任务视频！
          // 绝对不盲目认领未绑定 ID 的旧视频，防止误判导致连续提前提交后续任务！
          if (!isVideoGenerated && boundMediaIds.length > 0) {
            const candidateVideos = targetBatchContainer ? 
              Array.from(targetBatchContainer.querySelectorAll("video")) : 
              Array.from(document.querySelectorAll("flow-video-tile video, video"));

            for (const v of candidateVideos) {
              const src = (typeof v.getAttribute === "function" ? v.getAttribute("src") : null) || v.currentSrc || v.src;
              if (src && !isStaticShowcaseAsset(src)) {
                const vidId = mediaIdFromVideoUrl(src);
                if (vidId && boundMediaIds.includes(vidId)) {
                  console.log(`[Batch] 🎯 DOM 视频匹配到当前任务 boundMediaId=${vidId}: ${src.substring(0, 80)}`);
                  isVideoGenerated = true;
                  targetVideoUrl = src;
                  if (!binding.readyIds.includes(vidId)) binding.readyIds.push(vidId);
                  binding.urls = binding.urls || {};
                  binding.urls[vidId] = src;
                  break;
                }
              }
            }
          }

          // 5. 视频生成就绪后，调度自动下载
          if (isVideoGenerated && targetVideoUrl) {
            if (!downloadTriggered && !(Array.isArray(task.downloaded) && task.downloaded[lIdx])) {
              console.log("[Batch] 🚀 当前任务视频已就绪，发起自动下载:", targetVideoUrl.substring(0, 80));
              const dlOk = await triggerAutoDownload(targetVideoUrl, mediaIdFromVideoUrl(targetVideoUrl));
              console.log("[Batch] triggerAutoDownload 执行结果:", dlOk);
              if (dlOk) {
                downloadTriggered = true;
                updateLineStatus(rIdx, lIdx, "generating", `视频已就绪，已发起下载，正在等待保存文件 (${Math.round(waitedSec)}s)...`);
              }
            }
          } else {
            if (!task.downloaded[lIdx]) {
              const waitHint = boundMediaIds.length > 0 ? 
                `已分配服务端 ID [${boundMediaIds.join(', ')}]，渲染生成中 (${Math.round(waitedSec)}s)...` : 
                `正在生成中，已等待 ${Math.round(waitedSec)}s (完成后将自动下载)...`;
              updateLineStatus(rIdx, lIdx, "generating", waitHint);
            }
          }

          await delay(2000);
          waitedSec = (Date.now() - waitStartTime) / 1000;

          // 4. 下载完成严格校验
          if (task.status[lIdx] === "success" && (Array.isArray(task.downloaded) && task.downloaded[lIdx])) {
            isTaskCompleted = true;
            break;
          }
        }



        if (!isTaskCompleted && !isStopRequested && task.status[lIdx] !== "failed") {
          console.warn(`[Batch] 任务生成等待超时 (${maxWaitSec}s)`);
          updateLineStatus(rIdx, lIdx, "failed", `生成或下载超时 (等待超过 ${maxWaitSec} 秒)`);
        }

        window.currentProcess = null;
        state.activeTasksQueue = [];
        state.taskRecord = {};
        // 清理行内继续的指针，方便下一个任务从 0 行开始跑
        state.currentLineIndex = 0;
        await saveState();

        if (isStopRequested) {
          showToast("用户中断了批量任务！");
          onBatchFinished();
          return;
        }

        // 如果是单任务生成模式，该任务生成并下载完成后立即停止，不等待间隔，不进入下一项
        if (singleRowIndex !== null && typeof singleRowIndex === "number") {
          showToast(`单项任务 #${rIdx + 1} 生成与下载已完成！`);
          onBatchFinished();
          return;
        }

        // 任务下载完成后的批量间隔延时 (严格按照设定执行停顿，基于绝对时间戳保证失焦/后台准确走完)
        const intervalSec = Math.max(0, Number(state.settings.interval) || 0);
        const intervalRand = Math.max(0, Number(state.settings.intervalRandom) || 0);
        const waitTime = Math.round(intervalSec + Math.random() * intervalRand);
        const targetEndTime = Date.now() + waitTime * 1000;
        console.log(`[Batch] 当前任务已完成，等待间隔延迟: ${waitTime} 秒后进入下一项`);

        while (Date.now() < targetEndTime) {
          if (isStopRequested) break;
          const remainingSec = Math.max(1, Math.round((targetEndTime - Date.now()) / 1000));
          showToast(`当前视频已完成！将在 ${remainingSec} 秒后开始下一个任务...`, 1500);
          await delay(1000);
        }

        // 倒计时结束，在流转进入下一项前清理可能残留的遮罩与弹窗
        await cleanupPageOverlays();
      }
    }

    if (singleRowIndex !== null && typeof singleRowIndex === "number") {
      showToast(`单项任务执行已完成！`);
    } else {
      showToast("所有队列任务的批量生成提交已完成！");
    }
    onBatchFinished();
  }

  function stopBatch() {
    isStopRequested = true;
    stopActivityCheck();
    disableTabKeepAlive();
    state.isRunning = false;
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    saveState();
    showToast("正在停止队列，已提交到 Flow 的生成不会取消...");
  }

  function onBatchFinished() {
    stopActivityCheck();
    disableTabKeepAlive();
    
    state.isRunning = false;
    state.currentIndex = 0;
    state.currentLineIndex = 0;
    state.retryCount = 0;
    
    document.getElementById("btn-start-batch").style.setProperty("display", "inline-flex", "important");
    document.getElementById("btn-stop-batch").style.setProperty("display", "none", "important");
    
    window.currentProcess = null;
    state.activeTasksQueue = [];
    state.taskRecord = {};
    sendToExtension("clearActiveTask", {});
    saveState();
  }

  // ----------------------------------------------------
  // 自动化参数同步：模式、视频类型(帧/素材)、尺寸比例、分辨率、输出数量、时长
  // ----------------------------------------------------
  function durationError(message) {
    const error = new Error(message);
    error.configurationError = true;
    return error;
  }

  function findDurationGroup() {
    const overlay = document.querySelector(".cdk-overlay-pane flow-prompt-box-settings, flow-prompt-box-settings, .settings-content-overlay");
    if (!overlay) return null;
    return Array.from(overlay.querySelectorAll("flow-toggles[aria-label], [role='radiogroup'][aria-label], select[aria-label]"))
      .find(group => /时长|秒数|duration|length/i.test(group.getAttribute("aria-label") || "")) || null;
  }

  async function applyDurationSetting(value) {
    const target = normalizeDuration(value);
    if (target == null) return;
    let group;
    for (let attempt = 0; attempt < 10; attempt++) {
      group = findDurationGroup();
      if (group) break;
      if (isStopRequested) throw durationError("任务已停止");
      await delay(200);
    }
    if (!group) throw durationError(`找不到视频时长选项，无法确认 ${target} 秒；请检查当前模型的设置面板`);
    const options = () => Array.from(group.querySelectorAll("mat-button-toggle, [role='radio'], option"));
    const secondsOf = option => {
      try { return normalizeDuration(option.textContent.trim()); } catch (_) { return null; }
    };
    const selected = option => option.selected === true || option.classList.contains("mat-button-toggle-checked") ||
      option.getAttribute("aria-checked") === "true" || option.querySelector("button")?.getAttribute("aria-checked") === "true" ||
      option.querySelector("button")?.getAttribute("aria-pressed") === "true";
    const option = options().find(item => secondsOf(item) === target);
    if (!option) throw durationError(`当前模型不支持 ${target} 秒；可选时长：${options().map(secondsOf).filter(v => v != null).join("、") || "未识别"}`);
    if (!selected(option)) {
      if (group.tagName === "SELECT") {
        group.value = option.value;
        group.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const button = option.querySelector("button") || option;
        if (button.disabled || button.getAttribute("aria-disabled") === "true") throw durationError(`${target} 秒选项不可用`);
        button.click();
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      group = findDurationGroup();
      if (group && options().some(item => secondsOf(item) === target && selected(item))) return;
      if (isStopRequested) throw durationError("任务已停止");
      await delay(200);
    }
    throw durationError(`点击后未确认选中 ${target} 秒，已阻止生成`);
  }

  async function syncPageVideoSettings(settings) {
    const { resolution, aspectRatio, videoModel, footageType, count, duration } = settings;
    const targetCount = count || 1;
    const targetRes = resolution || "VIDEO_RESOLUTION_720P";
    const targetAspect = aspectRatio || "ASPECT_RATIO_9_16";
    const targetFootage = footageType || "VIDEO_FRAMES";

    console.log(`[FlowUI] 开始同步视频设置: 模式=${targetFootage}, 比例=${targetAspect}, 分辨率=${targetRes}, 数量=${targetCount}, 时长=${duration || '默认'}`);

    // 0. 尝试全局 store 兜底设置
    try {
      if (window.promptBoxStore && typeof window.promptBoxStore.setState === "function") {
        window.promptBoxStore.setState({
          videoResolution: targetRes,
          selectedVideoResolution: targetRes,
          resolution: targetRes,
          aspectRatio: targetAspect === "ASPECT_RATIO_9_16" ? "PORTRAIT" : (targetAspect === "ASPECT_RATIO_1_1" ? "SQUARE" : "LANDSCAPE"),
          outputsPerPrompt: targetCount,
          videoModelFamilyId: videoModel || "veo_2",
          mode: targetFootage
        });
      }
    } catch (storeErr) {
      console.warn("[FlowUI] promptBoxStore 兜底更新提示:", storeErr);
    }

    // 1. 定位页面底部的设置按钮
    const settingsBtn = document.querySelector("button.settings-trigger-button") || 
                        document.querySelector("div.submit-controls button:not(.generate-icon-button)") ||
                        document.querySelector("button[aria-label*='设置']");
    
    if (!settingsBtn) {
      throw durationError("未找到 Flow 设置按钮，无法确认任务秒数");
    }

    // 检查按钮文本摘要是否已经完全符合预期
    const summaryText = (settingsBtn.textContent || "").toLowerCase();
    const resKey = targetRes.includes("360") ? "360p" : (targetRes.includes("1080") ? "1080p" : "720p");
    const aspectKey = targetAspect.includes("9_16") ? "crop_9_16" : (targetAspect.includes("1_1") ? "crop_1_1" : "crop_16_9");
    const aspectTextKey = targetAspect.includes("9_16") ? "9:16" : (targetAspect.includes("1_1") ? "1:1" : "16:9");
    const countKey = `x${targetCount}`;

    const resMatched = summaryText.includes(resKey);
    const aspectMatched = summaryText.includes(aspectKey) || summaryText.includes(aspectTextKey);
    const countMatched = summaryText.includes(countKey);

    // 如果摘要已经完美满足（例如已是 720p、9:16 且 x1），无需重复开启设置弹窗
    if (duration == null && resMatched && aspectMatched && countMatched) {
      console.log(`[FlowUI] 当前设置摘要 (${settingsBtn.textContent.trim()}) 已满足要求，无需重复开启设置弹窗`);
      return;
    }

    // 2. 点击设置按钮弹出 CDK Overlay 设置面板
    console.log("[FlowUI] 正在点击设置按钮弹出设置面板...");
    settingsBtn.click();
    await delay(400);

    // 3. 在 CDK Overlay 面板内精确定位 flow-toggles 进行切换
    const overlay = document.querySelector(".cdk-overlay-pane flow-prompt-box-settings, flow-prompt-box-settings, .settings-content-overlay");
    if (!overlay) {
      throw durationError("未打开 Flow 设置面板，无法设置任务秒数");
    }

    // 通用切换助手：精确定位 flow-toggles[aria-label] 内部的 mat-button-toggle
    function setToggle(ariaLabel, matcher) {
      const toggleGroup = overlay.querySelector(`flow-toggles[aria-label="${ariaLabel}"]`) ||
                          overlay.querySelector(`flow-toggles[aria-label*="${ariaLabel}"]`);
      if (!toggleGroup) {
        console.warn(`[FlowUI] 设置面板内未找到切换组: [aria-label="${ariaLabel}"]`);
        return false;
      }
      const toggles = toggleGroup.querySelectorAll("mat-button-toggle");
      for (const t of toggles) {
        const text = (t.textContent || "").trim();
        const icon = (t.querySelector("mat-icon")?.textContent || "").trim();
        const isChecked = t.classList.contains("mat-button-toggle-checked") || 
                          t.querySelector("button")?.getAttribute("aria-checked") === "true";
        
        const isMatch = typeof matcher === "function" ? matcher(text, icon, t) : (text.includes(matcher) || icon.includes(matcher));
        if (isMatch) {
          if (!isChecked) {
            const btn = t.querySelector("button.mat-button-toggle-button") || t.querySelector("button") || t;
            console.log(`[FlowUI] 切换设置 [${ariaLabel}] -> ${text || icon}`);
            btn.click();
          } else {
            console.log(`[FlowUI] 设置 [${ariaLabel}] 已经是目标状态: ${text || icon}`);
          }
          return true;
        }
      }
      return false;
    }

    // (a) 模式: 切换为“视频”
    setToggle("模式", (text, icon) => text.includes("视频") || icon === "videocam");
    await delay(150);

    // (b) 视频类型: 切换为“帧”或“素材”
    if (targetFootage === "VIDEO_FRAMES") {
      setToggle("视频类型", (text, icon) => text.includes("帧") || icon === "crop_free");
    } else {
      setToggle("视频类型", (text, icon) => text.includes("素材") || icon === "chrome_extension");
    }
    await delay(150);

    // (c) 宽高比 / 尺寸: 切换为“9:16”或“16:9”
    if (targetAspect.includes("9_16")) {
      setToggle("宽高比", (text, icon) => text.includes("9:16") || icon === "crop_9_16");
    } else if (targetAspect.includes("1_1")) {
      setToggle("宽高比", (text, icon) => text.includes("1:1") || icon === "crop_1_1");
    } else {
      setToggle("宽高比", (text, icon) => text.includes("16:9") || icon === "crop_16_9");
    }
    await delay(150);

    // (d) 视频分辨率: 切换为 720p 或 360p
    setToggle("视频分辨率", (text) => text.includes(resKey));
    await delay(150);

    // (e) 输出数量: 强制切换为目标数量 (默认 x1)
    setToggle("输出数量", (text) => text === `x${targetCount}` || text.includes(`x${targetCount}`));
    await delay(150);

    // 必须精确选择并读取选中状态；不允许 6 匹配 16，也不忽略不支持的时长。
    try {
      await applyDurationSetting(duration);
    } catch (err) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      throw err;
    }

    // 4. 关闭设置面板
    console.log("[FlowUI] 完成设置配置，关闭设置弹窗...");
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      await delay(150);
      if (document.querySelector(".settings-content-overlay")) {
        settingsBtn.click();
      }
    } catch (e) {}

    await delay(300);
  }

  // 模拟真实的用户单击操作（仅执行一次完整的 down/up/click 流程，杜绝重复连击）
  function simulateClick(el) {
    if (!el) return;
    try { if (typeof el.focus === "function") el.focus(); } catch (_) {}
    try {
      if (typeof PointerEvent !== "undefined") {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
      }
    } catch (_) {}
    // 关键：严格只触发一次真实的 click，避免多次提交！
    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  }

  // 安全派发鼠标/指针事件（避免 click 事件被二次重复触发）
  function safeDispatchMouse(el, type) {
    if (!el) return;
    if (type === "click") {
      simulateClick(el);
      return;
    }
    try {
      if (typeof PointerEvent !== "undefined" && type.startsWith("pointer")) {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window }));
      } else if (typeof MouseEvent !== "undefined") {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    } catch (_) {}
  }

  // ----------------------------------------------------
  // 自动化关联素材原料：首帧注入 (帧模式) 或素材模式
  // ----------------------------------------------------
  async function attachImageToPage(image, footageType) {
    if (!image) return;
    const imgName = image.displayName || "";
    const imgSrc = image.src || "";
    const imgKey = image.primaryMediaKey || image.id || "";
    const isFrameMode = footageType === "VIDEO_FRAMES";

    console.log(`[FlowUI] 正在关联素材: Name="${imgName}", Key="${imgKey}", Mode="${footageType}"`);

    // 0. 尝试全局 store 注入兜底 (兼容 Flow 早先架构)
    try {
      if (window.promptBoxStore && typeof window.promptBoxStore.getState === "function") {
        const store = window.promptBoxStore.getState();
        if (store.actions && typeof store.actions.addImageIngredient === "function") {
          console.log("[FlowUI] 通过 promptBoxStore.addImageIngredient 注入素材原料");
          store.actions.addImageIngredient({
            imageId: imgKey || imgName,
            preferredIngredientType: isFrameMode ? "FIRST_FRAME" : "REFERENCE",
            source: "PLUS_BUTTON"
          });
          await delay(300);
          return;
        }
      }
    } catch (storeErr) {
      console.warn("[FlowUI] promptBoxStore.addImageIngredient 失败:", storeErr);
    }

    // 1. 核心通道：通过 flow-ingredient-bar 的“开始”帧槽位注入 (帧模式)
    const ingredientBar = document.querySelector("flow-ingredient-bar.prompt-ingredient-bar, .prompt-ingredient-bar, flow-ingredient-bar");
    if (ingredientBar) {
      const startTrigger = ingredientBar.querySelector(".frame-trigger:first-of-type, .frame-trigger");
      if (startTrigger) {
        // 如果首帧已有内容且匹配当前图片，无需重复添加
        const triggerImg = startTrigger.querySelector("img");
        const triggerTitle = extractTileDisplayName(startTrigger, triggerImg);
        const triggerText = startTrigger.textContent || "";
        if (imgName && (isImageNameMatch(imgName, triggerTitle) || isImageNameMatch(imgName, triggerText))) {
          console.log("[FlowUI] 首帧槽位中已存在匹配图片，无需重复注入:", imgName);
          return;
        }

        // 点击“开始”按钮（button.empty-chip 或 button）打开媒体选择面板
        const startBtn = startTrigger.querySelector("button.empty-chip") || startTrigger.querySelector("button");
        if (startBtn) {
          console.log("[FlowUI] 点击首帧触发器按钮 [开始] 弹出媒体选择面板...");
          simulateClick(startBtn);

          // 轮询等待媒体弹窗展开 (最多等待 3 秒)
          let overlayPanel = null;
          for (let w = 0; w < 20; w++) {
            await delay(150);
            const panels = Array.from(document.querySelectorAll(
              ".cdk-overlay-pane:not(:empty), .cdk-overlay-container .cdk-overlay-pane, [role='dialog'], [role='menu'], mat-dialog-container"
            )).filter(p => p.offsetWidth > 0 && p.offsetHeight > 0);
            if (panels.length) {
              overlayPanel = panels[panels.length - 1];
              const items = overlayPanel.querySelectorAll("flow-grid-tile-container, flow-image-tile, flow-tile, flow-media-tile, button:has(img), img");
              if (items.length > 0) break;
            }
          }

          if (overlayPanel) {
            console.log("[FlowUI] 成功检测到素材选择弹层面板，开始匹配素材...");

            // 在弹层中查找匹配的图片素材卡片
            const candidateItems = Array.from(overlayPanel.querySelectorAll(
              "flow-grid-tile-container, flow-image-tile, flow-tile, flow-media-tile, " +
              "[data-tile-id], [data-media-id], .media-item, [role='option'], mat-option, " +
              ".tile-row > div, button:has(img), div:has(> img)"
            ));

            let matchedCard = null;
            for (const item of candidateItems) {
              const itemImg = item.querySelector("img");
              const itemDisplayName = extractTileDisplayName(item, itemImg);
              const itemTitle = item.getAttribute("title") || item.querySelector("[title]")?.getAttribute("title") || "";
              const itemAlt = itemImg?.getAttribute("alt") || "";
              const itemAria = item.getAttribute("aria-label") || "";
              const itemText = item.textContent || "";
              const itemId = itemImg?.dataset?.mediaId || item.dataset?.mediaId || item.dataset?.tileId || "";

              if (imgKey && itemId && (imgKey === itemId || itemId.includes(imgKey) || imgKey.includes(itemId))) {
                matchedCard = item;
                break;
              }
              if (imgName && (isImageNameMatch(imgName, itemDisplayName) || isImageNameMatch(imgName, itemTitle) || isImageNameMatch(imgName, itemAlt) || isImageNameMatch(imgName, itemAria) || isImageNameMatch(imgName, itemText))) {
                matchedCard = item;
                break;
              }
            }

            // 如果名字未精确匹配，尝试在所有带 img 的卡片中寻找文件名子串
            if (!matchedCard) {
              const allImgTiles = Array.from(overlayPanel.querySelectorAll("flow-grid-tile-container, flow-image-tile, button:has(img), div:has(> img)"));
              for (const tile of allImgTiles) {
                const tName = extractTileDisplayName(tile, tile.querySelector("img"));
                if (imgName && tName && isImageNameMatch(imgName, tName)) {
                  matchedCard = tile;
                  break;
                }
              }
            }

            // 如果仍未匹配，且弹窗中只有少量图片，兜底选取第一张图片素材
            if (!matchedCard && candidateItems.length > 0) {
              const firstTile = overlayPanel.querySelector("flow-grid-tile-container:has(img), flow-image-tile, button:has(img)");
              if (firstTile && candidateItems.length <= 2) {
                console.log("[FlowUI] 弹窗中候选较少，选用第一张素材:", firstTile);
                matchedCard = firstTile;
              }
            }

            if (matchedCard) {
              console.log(`[FlowUI] 🎯 在首帧媒体面板中匹配到素材 [${imgName}]，触发选中点击！`);
              const clickTarget = matchedCard.querySelector("button, img, .container") || matchedCard;
              simulateClick(clickTarget);

              await delay(400);

              // 关键！自动检测并点击弹层中的“确认”、“确定”、“选择”、“添加”、“完成”按钮（彻底解放用户手动点击！）
              const allButtons = Array.from(document.querySelectorAll(
                ".cdk-overlay-container button, mat-dialog-actions button, .mat-mdc-dialog-actions button, .cdk-overlay-pane button"
              )).filter(btn => {
                if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
                const t = (btn.textContent || "").trim();
                const aria = (btn.getAttribute("aria-label") || "").trim();
                if (/^(取消|关闭|Cancel|Close|Dismiss)$/i.test(t) || /^(取消|关闭|Cancel|Close|Dismiss)$/i.test(aria)) return false;
                if (/(确认|确定|选择|添加|完成|使用|插入|首帧|Confirm|Select|Add|Done|OK|Apply|Insert)/i.test(t) ||
                    /(确认|确定|选择|添加|完成|使用|插入|首帧|Confirm|Select|Add|Done|OK|Apply|Insert)/i.test(aria)) return true;
                if (btn.closest("mat-dialog-actions, .mat-mdc-dialog-actions") && (btn.classList.contains("primary") || btn.classList.contains("flow-button-primary") || btn.classList.contains("mat-mdc-unelevated-button") || btn.classList.contains("mat-primary"))) return true;
                return false;
              });

              if (allButtons.length > 0) {
                const actionBtn = allButtons.find(b => /(确认|确定|选择|添加|完成|使用|首帧|Confirm|Select|Add|Done|OK|Apply)/i.test((b.textContent || "") + (b.getAttribute("aria-label") || ""))) || allButtons[allButtons.length - 1];
                console.log(`[FlowUI] 🎯 自动点击媒体选择弹窗确认按钮: "${(actionBtn.textContent || actionBtn.getAttribute('aria-label') || '').trim()}"`);
                simulateClick(actionBtn);
                await delay(500);
              }

              await delay(300);
              if (verifyImageAttached(image, footageType)) {
                console.log("[FlowUI] ✅ 首帧素材挂载成功！");
                return;
              }
            }

            // 如果弹窗仍未关闭，按 Escape 关闭弹层
            const stillOpen = !!document.querySelector(".cdk-overlay-pane:not(:empty) [role='dialog'], mat-dialog-container");
            if (stillOpen) {
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
              await delay(250);
            }
          }
        }
      }
    }

    // 2. 备选通道：输入框左下角加号菜单 (flow-add-menu)
    const addMenuBtn = document.querySelector("flow-add-menu button.add-menu-trigger, flow-add-menu button, button.add-menu-trigger, button.add-ingredient-button");
    if (addMenuBtn) {
      console.log("[FlowUI] 尝试点击输入框左下角加号菜单添加素材...");
      simulateClick(addMenuBtn);
      await delay(350);

      const menuPanels = Array.from(document.querySelectorAll(".cdk-overlay-pane, .flow-add-menu-dropdown-panel, .mat-mdc-menu-panel, [role='menu']"));
      for (const panel of menuPanels) {
        const options = Array.from(panel.querySelectorAll("button, [role='menuitem'], [role='option'], .flow-add-menu-dropdown-option-text, span"));
        let clickedOpt = false;
        for (const opt of options) {
          const optText = opt.textContent || "";
          if (imgName && isImageNameMatch(imgName, optText)) {
            console.log(`[FlowUI] 在素材菜单中找到匹配素材: ${optText.trim()}，点击添加`);
            simulateClick(opt);
            clickedOpt = true;
            await delay(300);
            break;
          }
        }
        if (clickedOpt) {
          await delay(300);
          return;
        }
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      await delay(200);
    }

    // 3. 备选策略：Base64 图片文件拖拽/粘贴注入
    if (imgSrc && imgSrc.startsWith("data:image/")) {
      try {
        console.log("[FlowUI] 尝试通过原生 Clipboard/Paste 事件注入图片 File...");
        const targetEditor = document.querySelector(".prompt-ingredient-bar .frame-trigger:first-of-type") ||
                             document.querySelector("flow-rich-text-editor div.ProseMirror") || 
                             document.querySelector("div.ProseMirror[contenteditable='true']");
        if (targetEditor) {
          const byteString = atob(imgSrc.split(",")[1]);
          const mimeString = imgSrc.split(",")[0].split(":")[1].split(";")[0];
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
          }
          const blob = new Blob([ab], { type: mimeString });
          const file = new File([blob], imgName || "ingredient.png", { type: mimeString });

          const dt = new DataTransfer();
          dt.items.add(file);

          const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
          targetEditor.dispatchEvent(dropEvent);

          const pasteEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
          targetEditor.dispatchEvent(pasteEvent);
          console.log("[FlowUI] 已向目标区域派发 File 注入事件");
          await delay(400);
        }
      } catch (fileErr) {
        console.warn("[FlowUI] File drop/paste 注入异常:", fileErr);
      }
    }
  }

  // 校验当前页面输入区域是否已成功挂载所要求的素材图片
  function verifyImageAttached(image, footageType) {
    if (!image || (!image.displayName && !image.src && !image.primaryMediaKey)) {
      return true; // 未指定图片（纯文本生成任务），直接放行
    }

    const isFrameMode = footageType === "VIDEO_FRAMES";

    // 1. 优先检查 flow.promptBoxStore 全局状态（如可用）
    try {
      if (window.promptBoxStore && typeof window.promptBoxStore.getState === "function") {
        const store = window.promptBoxStore.getState();
        if (store) {
          const ingredients = store.ingredients || store.imageIngredients || store.frames || [];
          if (Array.isArray(ingredients) && ingredients.length > 0) {
            return true;
          }
          if (store.startFrame || store.firstFrame || (store.frames && (store.frames.start || store.frames.first))) {
            return true;
          }
        }
      }
    } catch (e) {
      console.warn("[FlowUI] 检查 promptBoxStore 异常:", e);
    }

    // 2. 检查 DOM: flow-ingredient-bar / .prompt-ingredient-bar
    const ingredientBar = document.querySelector("flow-ingredient-bar.prompt-ingredient-bar, .prompt-ingredient-bar, flow-ingredient-bar");
    if (ingredientBar) {
      // 帧模式下检查首帧槽位 (.frame-trigger)
      if (isFrameMode) {
        const startTrigger = ingredientBar.querySelector(".frame-trigger:first-of-type, .frame-trigger");
        if (startTrigger) {
          const emptyBtn = startTrigger.querySelector("button.empty-chip");
          // 如果首帧中存在 img 标签或已不是 empty-chip，或者内容包含图片名称，则认为已挂载
          const hasImg = !!startTrigger.querySelector("img, flow-tile, flow-media-tile, [role='img']");
          const hasNonEmptyButton = !!startTrigger.querySelector("button:not(.empty-chip)");
          const triggerTitle = extractTileDisplayName(startTrigger, startTrigger.querySelector("img"));
          const triggerText = startTrigger.textContent || "";
          const matchesName = image.displayName && (isImageNameMatch(image.displayName, triggerTitle) || isImageNameMatch(image.displayName, triggerText));

          if (hasImg || hasNonEmptyButton || (!emptyBtn && triggerText.trim() !== "" && !triggerText.includes("开始") && !triggerText.includes("start")) || matchesName) {
            return true;
          }
          // 如果首帧明确包含 empty-chip，且没有缩略图，则说明首帧尚未挂上
          if (emptyBtn) {
            return false;
          }
        }
      }

      // 素材模式或通用检查：查看是否存在素材芯片、缩略图或移除按钮
      const hasChipOrImg = !!ingredientBar.querySelector(
        "img, flow-ingredient-chip, .ingredient-chip, mat-chip, .chip-container, button[aria-label*='移除'], button[aria-label*='Remove'], button[aria-label*='Clear'], .clear-button"
      );
      if (hasChipOrImg) return true;

      const barTitle = extractTileDisplayName(ingredientBar, ingredientBar.querySelector("img"));
      const barText = ingredientBar.textContent || "";
      if (image.displayName && (isImageNameMatch(image.displayName, barTitle) || isImageNameMatch(image.displayName, barText))) {
        return true;
      }
    }

    // 3. 检查富文本编辑器 (flow-rich-text-editor) 是否内嵌素材胶囊
    const editorChips = document.querySelectorAll("flow-rich-text-editor [data-chip-type], flow-rich-text-editor .ingredient-chip, flow-rich-text-editor img");
    if (editorChips.length > 0) {
      return true;
    }

    return false;
  }

  // 注入提示词至 ProseMirror 并触发 Angular 提交
  async function submitTaskToPage(params) {
    const { image, lineText, presetBefore, presetAfter, footageType, count, duration, rowIndex, lineIndex, resolution, aspectRatio, videoModel } = params;
    
    // 0. 同步视频尺寸比例、分辨率、视频类型(帧/素材)、输出数量与生成模型
    const targetRes = resolution || state.settings.resolution || "VIDEO_RESOLUTION_720P";
    const targetAspect = aspectRatio || state.settings.aspectRatio || "ASPECT_RATIO_9_16";
    const targetModel = videoModel || state.settings.videoModel || "veo_2";
    const targetFootage = footageType || state.settings.footageType || "VIDEO_FRAMES";
    const targetCount = count || state.settings.defaultCount || 1;

    // 关键修复 1：先同步页面设置（切换到目标模式如“帧”模式），确保 flow-ingredient-bar 显示出首帧槽位，且设置切换不会清除刚挂载的图片！
    try {
      await syncPageVideoSettings({
        resolution: targetRes,
        aspectRatio: targetAspect,
        videoModel: targetModel,
        footageType: targetFootage,
        count: targetCount,
        duration: duration
      });
    } catch (settErr) {
      throw settErr;
    }

    // 提交前清理历史弹窗与遮罩，确保输入框与按钮处于可交互视口
    await cleanupPageOverlays();

    // 关键修复 2：在目标模式设置好后，再挂载参考图片/首帧素材原料！
    if (image && (image.displayName || image.src || image.primaryMediaKey)) {
      try {
        await attachImageToPage(image, targetFootage);
      } catch (imgErr) {
        console.warn("[FlowUI] 注入图片原料异常 (继续执行):", imgErr);
      }
    }

    // 3. 定位 ProseMirror 输入框
    let editor = document.querySelector("flow-rich-text-editor div.ProseMirror") || 
                 document.querySelector("div.ProseMirror[contenteditable='true']");
    if (!editor) {
      for (let i = 0; i < 10; i++) {
        await delay(300);
        editor = document.querySelector("flow-rich-text-editor div.ProseMirror") || 
                 document.querySelector("div.ProseMirror[contenteditable='true']");
        if (editor) break;
      }
    }

    if (!editor) {
      throw new Error("页面上未找到提示词输入框 (flow-rich-text-editor ProseMirror)");
    }

    // 4. 拼装拼接后的提示词
    const finalPrompt = `${presetBefore || ""}
${lineText || ""}
${presetAfter || ""}`.trim();
    params.finalPrompt = finalPrompt;
    console.log(`[FlowUI] 正在填入提示词 (第 ${rowIndex + 1} 个任务, 子行 ${lineIndex + 1}): "${finalPrompt.substring(0, 60)}..."`);

    // 5. 注入文本到 ProseMirror 编辑器 (支持多行段落，绝不让 ProseMirror 报错)
    try {
      editor.focus();
    } catch (e) {}

    let textInjected = false;

    // 策略 A: ProseMirror View 原生多行段落事务注入
    if (editor.pmViewDesc && editor.pmViewDesc.view) {
      try {
        const view = editor.pmViewDesc.view;
        const schema = view.state.schema;
        const lines = finalPrompt.split("\n");
        const pType = schema.nodes.paragraph;
        const paragraphs = lines.map(line => {
          return line ? pType.create(null, schema.text(line)) : pType.create();
        });
        const docNode = schema.nodes.doc.create(null, paragraphs);
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, docNode.content);
        view.dispatch(tr);
        textInjected = true;
        console.log("[FlowUI] 已通过 ProseMirror EditorView.dispatch 原生注入多行段落文本");
      } catch (pmErr) {
        console.warn("[FlowUI] ProseMirror View dispatch 异常，转入 DOM 注入:", pmErr);
      }
    }

    // 策略 B: DOM 原生选中与 execCommand
    if (!textInjected) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        textInjected = document.execCommand("insertText", false, finalPrompt);
      } catch (domErr) {
        console.warn("[FlowUI] execCommand 注入失败:", domErr);
      }
    }

    // 策略 C: 结构化段落替换
    if (!textInjected || editor.textContent.trim() !== finalPrompt) {
      if (typeof editor.replaceChildren === "function") {
        const paragraphs = finalPrompt.split("\n").map(l => {
          const p = document.createElement("p");
          p.textContent = l || "";
          return p;
        });
        editor.replaceChildren(...paragraphs);
      } else if (typeof editor.appendChild === "function") {
        editor.innerHTML = "";
        const lines = finalPrompt.split("\n");
        lines.forEach(l => {
          const p = document.createElement("p");
          p.textContent = l || "";
          editor.appendChild(p);
        });
      } else {
        editor.textContent = finalPrompt;
      }
    }

    // 派发全面的事件确保 Angular 表单状态更新为 valid
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: finalPrompt }));
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    window.promptBoxStore?.getState?.().actions?.setText?.(finalPrompt);
    window.promptBoxStore?.getState?.().actions?.setPrompt?.(finalPrompt);

    // 6. 提交前图片挂载状态二次复核与补救
    if (image && (image.displayName || image.src || image.primaryMediaKey)) {
      let isMounted = verifyImageAttached(image, targetFootage);
      if (!isMounted) {
        console.warn(`[FlowUI] ⚠️ 提交前首次检查发现素材 [${image.displayName || "图片"}] 尚未挂载，等待后复检...`);
        await delay(400);
        isMounted = verifyImageAttached(image, targetFootage);
      }
      if (!isMounted) {
        console.warn(`[FlowUI] ⚠️ 正在执行二次挂载素材重试...`);
        await attachImageToPage(image, targetFootage);
        await delay(600);
        isMounted = verifyImageAttached(image, targetFootage);
      }
      if (isMounted) {
        console.log(`[FlowUI] ✅ 提交前图片挂载校验通过: [${image.displayName || "素材图片"}] 已正确挂载到输入框！`);
      } else {
        console.warn(`[FlowUI] ⚠️ 挂载检测未直接捕获到芯片，继续执行发送...`);
      }
    }

    // 7. 查找生成按钮并确保可点击发送
    const findButton = () => document.querySelector(
      "flow-generate-icon-button button, button.generate-icon-button, button[aria-label*='生成'], button[aria-label*='开始'], button[aria-label*='Generate']"
    );
    let button;
    for (let i = 0; i < 40; i++) {
      if (isStopRequested) throw new Error("用户已停止任务");
      button = findButton();
      if (!state.isSuspended && button && !button.disabled && !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true") break;
      // 若按钮仍 disabled，尝试重新派发输入事件激活
      if (button && (button.disabled || button.getAttribute("aria-disabled") === "true")) {
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
      }
      button = null;
      await delay(500);
    }
    if (!button) {
      button = findButton();
      if (button) {
        console.warn("[FlowUI] ⚠️ 生成按钮超时未就绪，强制解除 disabled 限制触发点击");
        button.removeAttribute("disabled");
        button.disabled = false;
        button.setAttribute("aria-disabled", "false");
      } else {
        throw new Error("Flow 生成按钮尚未就绪，请检查页面提示");
      }
    }

    await sendToExtension("setActiveTask", {
      download_path: resolveDownloadPath(params.download_path, params),
      rowIndex, lineIndex, projectId: getStorageKey()
    });
    if (isStopRequested) throw new Error("用户已停止任务");
    params.submissionId = crypto.randomUUID();
    const task = state.tasks[rowIndex];
    task.taskId = task.taskId || crypto.randomUUID();
    task.mediaBindings = task.mediaBindings || [];
    task.downloadIds = task.downloadIds || [];
    task.downloadIds[lineIndex] = null;
    task.videoUrls = task.videoUrls || [];
    task.videoUrls[lineIndex] = null;
    task.mediaBindings[lineIndex] = {
      schema: 2, submissionId: params.submissionId, taskId: task.taskId,
      mediaIds: [], readyIds: [], downloadPath: resolveDownloadPath(params.download_path, params)
    };

    await saveState();
    if (isStopRequested) throw new Error("用户已停止任务");
    window.currentProcess = params;
    state.activeTasksQueue = [params];

    console.log("[FlowUI] 🚀 正在触发生成按钮点击发送 (严格单次原生单击):", button);
    simulateClick(button);
    await delay(500);
  }

  function getProjectTiles() {
    return Array.from(document.querySelectorAll("flow-grid-tile-container:has(flow-video-tile video)"));
  }

  function isFlowCurrentlyGenerating() {
    return !!document.querySelector("flow-generate-icon-button mat-spinner, flow-generate-icon-button .mat-mdc-progress-spinner");
  }


  function resolveDownloadPath(downloadPath, processInfo = {}) {
    if (typeof downloadPath === "string" && downloadPath.trim()) {
      const parts = downloadPath.trim().replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, "").split("/").filter(Boolean);
      const filename = sanitizePathName(parts.pop());
      const downloadsIndex = parts.indexOf("downloads");
      const folder = downloadsIndex > 0 ? parts[downloadsIndex - 1] : parts[parts.length - 1];
      return `Flow/${sanitizePathName(folder || getProjectName())}/${filename}`;
    }
    const name = sanitizePathName((processInfo.image?.displayName || `task_${(processInfo.rowIndex || 0) + 1}`).replace(/\.\w*$/, ""));
    return `Flow/${sanitizePathName(getProjectName())}/${name}-${(processInfo.lineIndex || 0) + 1}.mp4`;
  }

  function isStaticShowcaseAsset(url) {
    return !url || /\/website\/flow\/|\/flow_camera\/|\/showcase\/|gstatic\.com|recaptcha|(?:left|right|center|high)\.mp4/i.test(url);
  }

  function videoIdentity(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "flow-content.google" && parsed.pathname.startsWith("/video/")) return parsed.origin + parsed.pathname;
      if (parsed.hostname === "flow.google.com" && parsed.pathname.startsWith("/asb/")) return parsed.origin + parsed.pathname;
    } catch (_) {}
    return url;
  }

  function mediaIdFromVideoUrl(value) {
    try {
      const url = new URL(value);
      if (url.hostname === "flow-content.google") return url.pathname.match(/^\/video\/([a-zA-Z0-9_-]+)$/)?.[1] || null;
      if (url.hostname === "flow.google.com" && url.pathname.startsWith("/asb/")) {
        return url.pathname.match(/^\/asb\/([a-zA-Z0-9_-]+)/)?.[1] || null;
      }
      if (url.hostname === "labs.google" && url.pathname === "/fx/api/trpc/media.getMediaUrlRedirect") {
        const name = url.searchParams.get("name") || "";
        return name.match(/(?:^|\/)media\/([a-zA-Z0-9_-]+)$/)?.[1] || (/^[a-zA-Z0-9_-]+$/.test(name) ? name : null);
      }
    } catch (_) {}
    return null;
  }

  function wasVideoSeen(url) {
    const identity = videoIdentity(url);
    return Array.from(downloadedUrlsSet).some(seen => videoIdentity(seen) === identity);
  }

  function findMediaBinding(mediaId) {
    if (!mediaId) return null;
    for (let rowIndex = 0; rowIndex < state.tasks.length; rowIndex++) {
      const task = state.tasks[rowIndex];
      for (let lineIndex = 0; lineIndex < (task.mediaBindings || []).length; lineIndex++) {
        const binding = task.mediaBindings[lineIndex];
        if (binding?.schema === 2 && binding.mediaIds.includes(mediaId)) return { task, binding, rowIndex, lineIndex };
      }
    }
    return null;
  }

  // 定位属于当前任务行的批次容器 (基于 mediaId 强绑定与提示词特征双向匹配，绝不盲目回退)
  function findCurrentBatchContainer(activeTask, lineIndex) {
    const activeProcess = window.currentProcess;
    const binding = activeTask?.mediaBindings?.[lineIndex];
    const boundIds = binding?.mediaIds || [];
    const containers = Array.from(document.querySelectorAll(".batch-container, .virtual-item-container"));
    if (!containers.length) return null;

    // 优先策略 1: 如果容器内的 video 包含当前任务绑定的 mediaId，100% 确认为本任务容器！
    if (boundIds.length > 0) {
      for (const container of containers) {
        const videos = Array.from(container.querySelectorAll("video"));
        for (const v of videos) {
          const src = (typeof v.getAttribute === "function" ? v.getAttribute("src") : null) || v.currentSrc || v.src;
          const vId = mediaIdFromVideoUrl(src);
          if (vId && boundIds.includes(vId)) {
            console.log(`[FlowUI] 🎯 [findCurrentBatchContainer] 根据 mediaId (${vId}) 精准锁定当前任务批次容器`);
            return container;
          }
        }
      }
    }

    // 优先策略 2: 提示词专属特征比对 (中段与结尾关键词比对，防止前缀模板词导致误匹配旧批次)
    const targetPrompt = (activeProcess?.finalPrompt || activeProcess?.lineText || activeTask?.lines?.[lineIndex] || "").trim();
    if (targetPrompt) {
      const cleanTarget = targetPrompt.replace(/\s+/g, "");
      const midPoint = Math.floor(cleanTarget.length / 2);
      const midSnippet = cleanTarget.substring(Math.max(0, midPoint - 15), Math.min(cleanTarget.length, midPoint + 15));
      const endSnippet = cleanTarget.slice(-25);

      for (const container of containers) {
        const promptEl = container.querySelector(".prompt-text, flow-expandable-prompt");
        const domText = (promptEl ? (promptEl.innerText || promptEl.textContent || "") : "").replace(/\s+/g, "");
        if (domText) {
          const isFullMatch = domText.includes(cleanTarget) || cleanTarget.includes(domText);
          const isSnippetMatch = (midSnippet && domText.includes(midSnippet)) || (endSnippet && domText.includes(endSnippet));
          if (isFullMatch || isSnippetMatch) {
            console.log("[FlowUI] 🎯 [findCurrentBatchContainer] 根据提示词特征精准锁定当前任务批次容器");
            return container;
          }
        }
      }
    }

    // 严禁盲目返回 containers[0]，若当前任务的新批次尚未生成，必须返回 null 继续等待！
    return null;
  }

  async function triggerDownloadFromNewestTile() {
    console.log("[FlowUI] 🔍 triggerDownloadFromNewestTile 开始扫描当前任务批次 video 元素...");
    const activeTask = state.tasks[state.currentIndex];
    const targetBatchContainer = findCurrentBatchContainer(activeTask, state.currentLineIndex);

    const targetTiles = targetBatchContainer ? 
      Array.from(targetBatchContainer.querySelectorAll("flow-video-tile")) : 
      Array.from(document.querySelectorAll("flow-video-tile"));
    if (targetTiles.length > 0) {
      triggerTileHover(targetTiles[0]);
      await delay(300);
    }
    const videoList = targetBatchContainer ? 
      Array.from(targetBatchContainer.querySelectorAll("video")) : 
      Array.from(document.querySelectorAll("flow-video-tile video, video"));
    console.log(`[FlowUI] triggerDownloadFromNewestTile 找到 ${videoList.length} 个 video 元素`);
    for (const video of videoList) {
      const src = (typeof video.getAttribute === "function" ? video.getAttribute("src") : null) || video.currentSrc || video.src;
      console.log(`[FlowUI] 尝试对 video 触发下载: src=${(src || '').substring(0, 80)}`);
      if (src && await triggerAutoDownload(src)) return true;
    }

    // 备用通道: 点击当前批次专属的原生批量下载按钮
    const newestDownloadBtn = targetBatchContainer ? 
      targetBatchContainer.querySelector("button[aria-label='批量下载']") : 
      document.querySelector(".batch-container button[aria-label='批量下载'], flow-batch-info button[aria-label='批量下载'], button[aria-label='批量下载']");
    if (newestDownloadBtn && !newestDownloadBtn.disabled) {
      console.log("[FlowUI] 备用通道: 尝试点击当前批次专属的 [批量下载] 按钮...");
      newestDownloadBtn.click();
      return true;
    }
    return false;
  }

  async function retrySavedVideo(task, rowIndex, lineIndex) {
    const binding = task.mediaBindings?.[lineIndex];
    console.log(`[FlowUI] [retrySavedVideo] 开始重试任务行: Row=${rowIndex}, Line=${lineIndex}, binding=`, binding);
    if (binding?.schema !== 2 || !binding.mediaIds.length) {
      console.warn(`[FlowUI] [retrySavedVideo] 无法重试: binding.schema=${binding?.schema}, mediaIds.length=${binding?.mediaIds?.length || 0}`);
      updateLineStatus(rowIndex, lineIndex, "failed", "未取得服务端媒体 ID，已禁止自动下载和重新生成。需要检查生成接口响应。");
      isStopRequested = true;
      return false;
    }
    binding.downloading = false;
    if (task.downloadIds?.[lineIndex]) {
      const existing = await sendToExtension("getDownloadStatus", { downloadId: task.downloadIds[lineIndex] });
      console.log(`[FlowUI] [retrySavedVideo] 检查已有 downloadId=${task.downloadIds[lineIndex]} 状态:`, existing);
      if (existing?.state === "complete") {
        task.downloaded[lineIndex] = true;
        updateLineStatus(rowIndex, lineIndex, "success", "对应视频下载已完成");
        return true;
      }
      if (existing?.state === "in_progress") {
        updateLineStatus(rowIndex, lineIndex, "generating", "等待对应 ID 的下载完成...");
        return true;
      }
      task.downloadIds[lineIndex] = null;
    }
    const mediaId = binding.readyIds[0];
    let url = binding.urls?.[mediaId];
    console.log(`[FlowUI] [retrySavedVideo] readyMediaId=${mediaId}, boundUrl=${url}`);
    if (!mediaId || !url) {
      console.warn(`[FlowUI] [retrySavedVideo] 缺少就绪 mediaId 或 url (mediaId=${mediaId}, url=${url})，等待成功状态`);
      updateLineStatus(rowIndex, lineIndex, "generating", "已取得媒体 ID，等待该 ID 的成功状态...");
      return true;
    }
    for (const video of document.querySelectorAll("flow-video-tile video")) {
      const candidate = video.getAttribute("src") || video.currentSrc || video.src;
      if (mediaIdFromVideoUrl(candidate) === mediaId) {
        console.log(`[FlowUI] [retrySavedVideo] 从 DOM flow-video-tile 找到更新的 URL 签名: ${candidate.substring(0, 80)}`);
        url = candidate;
      }
    }
    updateLineStatus(rowIndex, lineIndex, "generating", "重试下载已确认完成的媒体 ID...");
    return triggerAutoDownload(url, mediaId);
  }

  async function triggerAutoDownload(videoUrl, mediaName) {
    if (!state.isRunning) {
      console.warn("[FlowUI] [AutoDownload] 🚫 拒绝下载: state.isRunning 为 false (批量任务已停止)");
      return false;
    }
    if (typeof videoUrl !== "string") {
      console.warn("[FlowUI] [AutoDownload] 🚫 拒绝下载: videoUrl 不是有效字符串", videoUrl);
      return false;
    }
    const cleanUrl = videoUrl.trim().replace(/&amp;/g, "&");
    const mediaId = mediaIdFromVideoUrl(cleanUrl);
    console.log(`[FlowUI] [AutoDownload] 🔍 尝试自动下载: videoUrl=${cleanUrl.substring(0, 100)}, mediaId=${mediaId}, 传入mediaName=${mediaName || '未指定'}`);
    if (!mediaId) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 无法从 URL 解析出有效的 mediaId! URL: ${cleanUrl}`);
      return false;
    }
    if (mediaName && mediaName !== mediaId) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 传入的 mediaName (${mediaName}) 与从 URL 解析出的 mediaId (${mediaId}) 不一致!`);
      return false;
    }
    let match = findMediaBinding(mediaId);
    if (!match && state.isRunning) {
      const activeTask = state.tasks[state.currentIndex];
      const activeBinding = activeTask?.mediaBindings?.[state.currentLineIndex];
      const isGenerating = activeTask?.status?.[state.currentLineIndex] === "generating" && !activeTask?.downloaded?.[state.currentLineIndex];
      if (isGenerating && activeBinding && (!activeBinding.mediaIds || activeBinding.mediaIds.length === 0) && !wasVideoSeen(cleanUrl) && !isStaticShowcaseAsset(cleanUrl)) {
        // 确保该 video 在 DOM 的视频图块中
        const matchingVideoEl = Array.from(document.querySelectorAll("flow-video-tile video, flow-grid-tile-container video, video")).find(v => {
          if (!v) return false;
          const vSrc = (typeof v.getAttribute === "function" ? v.getAttribute("src") : null) || v.currentSrc || v.src;
          const hasTileParent = typeof v.closest === "function" ? !!(v.closest("flow-video-tile") || (v.closest("flow-grid-tile-container") && !v.closest("flow-image-tile"))) : true;
          return mediaIdFromVideoUrl(vSrc) === mediaId && hasTileParent;
        });
        if (matchingVideoEl) {
          console.log(`[FlowUI] 🎯 [AutoDownload] 从 DOM 视频图块中验证属于当前生成任务! 自动建立绑定: mediaId=${mediaId}, Row=${state.currentIndex}, Line=${state.currentLineIndex}`);
          activeBinding.mediaIds = [mediaId];
          if (!activeBinding.readyIds.includes(mediaId)) activeBinding.readyIds.push(mediaId);
          activeBinding.urls = activeBinding.urls || {};
          activeBinding.urls[mediaId] = cleanUrl;
          await saveState();
          match = { task: activeTask, binding: activeBinding, rowIndex: state.currentIndex, lineIndex: state.currentLineIndex };
        }
      }
    }
    if (!match) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 未在任何任务行中找到已绑定 mediaId=${mediaId} 的记录! 当前任务绑定列表:`, state.tasks.map((t, i) => ({ rowIndex: i, bindings: t.mediaBindings })));
      return false;
    }
    const { task, binding, rowIndex, lineIndex } = match;
    console.log(`[FlowUI] [AutoDownload] 🎯 匹配到任务行: Row=${rowIndex}, Line=${lineIndex}, 关联图片=[${task.image?.displayName || '未命名'}], 目标文件名=${binding.downloadPath}`);
    if (rowIndex !== state.currentIndex || lineIndex !== state.currentLineIndex) {
      console.log(`[FlowUI] [AutoDownload] ℹ️ 提示: 此就绪视频属于任务 Row=${rowIndex}, Line=${lineIndex} (当前队列处理指针为 Row=${state.currentIndex}, Line=${state.currentLineIndex})，继续为该任务行独立执行下载保存，绝不丢弃！`);
    }
    if (!binding.readyIds.includes(mediaId)) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: mediaId (${mediaId}) 尚未就绪 (不在 readyIds 中)! 当前 readyIds:`, binding.readyIds);
      return false;
    }
    if (binding.downloading) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 任务当前正在下载中 (binding.downloading=true)`);
      return false;
    }
    if (task.downloaded?.[lineIndex]) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 任务行已被标记为已下载完成 (downloaded=true)`);
      return false;
    }
    if (task.downloadIds?.[lineIndex]) {
      console.warn(`[FlowUI] [AutoDownload] 🚫 拒绝下载: 任务行已有活跃下载 ID (${task.downloadIds[lineIndex]})`);
      return false;
    }
    if (!binding.downloadPath) {
      console.error(`[FlowUI] [AutoDownload] ❌ 失败: 此任务缺少已绑定的下载文件名 (downloadPath 为空)`);
      updateLineStatus(rowIndex, lineIndex, "failed", "此任务缺少已绑定的下载文件名，已停止下载");
      return false;
    }
    binding.downloading = true;
    try {
      task.videoUrls = task.videoUrls || [];
      task.videoUrls[lineIndex] = cleanUrl;
      await saveState();
      console.log(`[FlowUI] [AutoDownload] 🚀 发送下载请求到后台: URL=${cleanUrl}, Filename=${binding.downloadPath}, MediaId=${mediaId}`);
      const result = await sendToExtension("download", {
        url: cleanUrl, filename: binding.downloadPath,
        task: { rowIndex, lineIndex, taskId: task.taskId, submissionId: binding.submissionId,
          mediaId, projectId: getStorageKey(), download_path: binding.downloadPath }
      });
      console.log("[FlowUI] [AutoDownload] 后台下载响应结果:", result);
      if (!result?.success) {
        console.error(`[FlowUI] [AutoDownload] ❌ 对应视频下载失败: ${result?.error || "无下载响应"}`);
        updateLineStatus(rowIndex, lineIndex, "failed", `对应视频下载失败: ${result?.error || "无下载响应"}`);
        return false;
      }
      task.downloadIds = task.downloadIds || [];
      task.downloadIds[lineIndex] = result.downloadId;
      console.log(`[FlowUI] [AutoDownload] ✅ 下载成功启动! downloadId=${result.downloadId}`);
      if (!task.downloaded?.[lineIndex] && task.status?.[lineIndex] !== "failed") updateLineStatus(rowIndex, lineIndex, "generating", `正在下载 ${binding.downloadPath}`);
      await saveState();
      return true;
    } finally { binding.downloading = false; }
  }

  // 模拟真实用户鼠标悬停，唤醒 Google Flow 视频卡片的懒加载预览机制 (严禁点击与聚焦)
  function triggerTileHover(tile) {
    if (!tile) return;
    // 严禁触碰任何图片卡片
    if (tile.tagName === "FLOW-IMAGE-TILE" || (tile.querySelector && tile.querySelector("flow-image-tile")) || (typeof tile.closest === "function" && tile.closest("flow-image-tile"))) {
      return;
    }

    try {
      if (typeof tile.scrollIntoView === "function") {
        tile.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    } catch (_) {}

    const videoTile = tile.tagName === "FLOW-VIDEO-TILE" ? tile : ((tile.querySelector && tile.querySelector("flow-video-tile")) || tile);

    const elementsToTrigger = [
      videoTile,
      videoTile.querySelector && videoTile.querySelector(".container"),
      videoTile.querySelector && videoTile.querySelector(".pre-hover-overlay"),
      videoTile.querySelector && videoTile.querySelector(".hover-overlay-has-progress-bar"),
      videoTile.querySelector && videoTile.querySelector(".type-icon-container")
    ].filter(Boolean);

    let clientX = 100, clientY = 100;
    try {
      const rect = videoTile.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        clientX = Math.round(rect.left + rect.width / 2);
        clientY = Math.round(rect.top + rect.height / 2);
      }
    } catch (_) {}

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      buttons: 0
    };

    const pointerInit = {
      ...eventInit,
      pointerId: 1,
      width: 1,
      height: 1,
      pressure: 0,
      isPrimary: true,
      pointerType: "mouse"
    };

    const createEvt = (type, init) => {
      try {
        if (type.startsWith("pointer") && typeof PointerEvent === "function") {
          return new PointerEvent(type, init);
        }
        if (typeof MouseEvent === "function") {
          return new MouseEvent(type, init);
        }
      } catch (_) {}
      return { type, bubbles: true, cancelable: true, ...init };
    };

    for (const el of elementsToTrigger) {
      try {
        if (typeof PointerEvent === "function" || (typeof window !== "undefined" && typeof window.PointerEvent === "function")) {
          el.dispatchEvent(createEvt("pointerover", pointerInit));
          el.dispatchEvent(createEvt("pointerenter", pointerInit));
          el.dispatchEvent(createEvt("pointermove", pointerInit));
        }
        el.dispatchEvent(createEvt("mouseover", eventInit));
        el.dispatchEvent(createEvt("mouseenter", eventInit));
        el.dispatchEvent(createEvt("mousemove", eventInit));
      } catch (_) {}
    }
  }

  // DOM 视频观察器：监听页面 <video> 标签及属性渲染
  function setupDomVideoWatcher() {
    console.log("[FlowUI] 启动 DOM 级视频渲染观察器...");

    function checkVideoElement(videoEl) {
      if (!videoEl || !state.isRunning) return;
      const renderedUrl = videoEl.getAttribute("src") || videoEl.currentSrc || videoEl.src;
      const renderedId = mediaIdFromVideoUrl(renderedUrl);
      let bound = findMediaBinding(renderedId);
      // 如果该任务视频已经下载完成，直接忽略，避免生命周期事件造成重复日志
      if (bound && bound.task?.downloaded?.[bound.lineIndex]) return;

      const inTile = !!(videoEl.closest("flow-video-tile") || videoEl.closest("flow-grid-tile-container"));

      // 核心救砖兜底：若网络 RPC 未能提取绑定 mediaIds (binding.mediaIds 为空)，
      // 但 DOM 中新渲染出了未见过的 flow-video-tile 视频卡片：
      if (!bound && state.isRunning && renderedId && inTile && renderedUrl) {
        const cleanUrl = renderedUrl.trim().replace(/&amp;/g, "&");
        if (!isStaticShowcaseAsset(cleanUrl) && !wasVideoSeen(cleanUrl)) {
          const activeTask = state.tasks[state.currentIndex];
          const activeBinding = activeTask?.mediaBindings?.[state.currentLineIndex];
          const isGenerating = activeTask?.status?.[state.currentLineIndex] === "generating" && !activeTask?.downloaded?.[state.currentLineIndex];

          if (isGenerating && activeBinding && (!activeBinding.mediaIds || activeBinding.mediaIds.length === 0)) {
            // 校验 DOM 提示词容器
            const batchContainer = videoEl.closest(".batch-container, .virtual-item-container") || videoEl.closest("flow-batch-info")?.parentElement;
            const promptTextEl = batchContainer ? batchContainer.querySelector(".prompt-text, flow-expandable-prompt") : null;
            const domPrompt = promptTextEl ? (promptTextEl.innerText || promptTextEl.textContent || "").trim() : "";
            const activeProcess = window.currentProcess;
            const targetPrompt = (activeProcess?.finalPrompt || activeProcess?.lineText || activeTask.lines?.[state.currentLineIndex] || "").trim();

            const isPromptMatch = !domPrompt || !targetPrompt ||
              domPrompt.includes(targetPrompt.substring(0, 20)) ||
              targetPrompt.includes(domPrompt.substring(0, 20)) ||
              domPrompt.slice(-20) === targetPrompt.slice(-20);

            if (isPromptMatch) {
              console.log(`[FlowUI] 🎯 [DOMWatcher] 识别到当前生成任务对应的新视频图块! 自动建立绑定: mediaId=${renderedId}, Row=${state.currentIndex}, Line=${state.currentLineIndex}`);
              activeBinding.mediaIds = [renderedId];
              if (!activeBinding.readyIds.includes(renderedId)) activeBinding.readyIds.push(renderedId);
              activeBinding.urls = activeBinding.urls || {};
              activeBinding.urls[renderedId] = cleanUrl;
              saveState();
              bound = { task: activeTask, binding: activeBinding, rowIndex: state.currentIndex, lineIndex: state.currentLineIndex };
            }
          }
        }
      }

      console.log(`[FlowUI] [DOMWatcher] 检查 video 元素: src=${(renderedUrl || '').substring(0, 80)}, renderedId=${renderedId}, readyState=${videoEl.readyState}, inTile=${inTile}, isBound=${!!bound}`);
      if (bound && (videoEl.readyState >= 1 || videoEl.currentTime > 0) && !videoEl.error && inTile) {
        console.log(`[FlowUI] [DOMWatcher] 视频元素已就绪 (readyState=${videoEl.readyState})，更新 readyId 并启动下载: renderedId=${renderedId}`);
        if (!bound.binding.readyIds.includes(renderedId)) bound.binding.readyIds.push(renderedId);
        bound.binding.urls = bound.binding.urls || {};
        bound.binding.urls[renderedId] = renderedUrl;
        triggerAutoDownload(renderedUrl, renderedId);
      } else if (bound && videoEl.readyState < 1) {
        console.log(`[FlowUI] [DOMWatcher] 视频元素匹配到任务 (Row=${bound.rowIndex}, Line=${bound.lineIndex})，但 readyState=${videoEl.readyState} < 1，等待 loadedmetadata...`);
      }

      const src = videoEl.getAttribute("src") || videoEl.currentSrc || videoEl.src;
      if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
        if (!isStaticShowcaseAsset(src) && !wasVideoSeen(src)) {
          const hasActiveWork = (state.activeTasksQueue && state.activeTasksQueue.length > 0) ||
                                (state.tasks && state.tasks.some(t => t.status && t.status.some(s => s === "generating")));
          if (hasActiveWork) {
            console.log("[FlowUI] DOM 观察器嗅探到新生成的视频元素:", src.substring(0, 100));
            triggerAutoDownload(src);
          }
        }
      }
    }

    for (const eventName of ["loadedmetadata", "loadeddata", "canplay"]) {
      document.addEventListener(eventName, event => {
        if (event.target?.tagName === "VIDEO") {
          console.log(`[FlowUI] [DOMWatcher] 监听到视频事件 [${eventName}], src=${(event.target.currentSrc || event.target.src || '').substring(0, 80)}`);
          checkVideoElement(event.target);
        }
      }, true);
    }
    // 监听 DOM 树变化
    const observer = new MutationObserver((mutations) => {
      if (!state.isRunning) return;
      for (const m of mutations) {
        if (m.addedNodes) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === "VIDEO") {
                checkVideoElement(node);
              } else {
                if (node.tagName === "FLOW-VIDEO-TILE") {
                  triggerTileHover(node);
                }
                if (node.querySelectorAll) {
                  node.querySelectorAll("flow-video-tile").forEach(triggerTileHover);
                  node.querySelectorAll("flow-video-tile video, video").forEach(checkVideoElement);
                }
              }
            }
          }
        }
        if (m.type === "attributes" && m.target && m.target.tagName === "VIDEO") {
          checkVideoElement(m.target);
        }
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "currentSrc"]
    });

    // 周期性主动扫描保底 (每 2 秒，仅在任务运行中，优先锁定当前批次)
    setInterval(() => {
      if (!state.isRunning) return;
      const hasActiveWork = (state.activeTasksQueue && state.activeTasksQueue.length > 0) ||
                            (state.tasks && state.tasks.some(t => t.status && t.status.some(s => s === "generating")));
      if (hasActiveWork) {
        const activeTask = state.tasks[state.currentIndex];
        const targetBatchContainer = findCurrentBatchContainer(activeTask, state.currentLineIndex);
        if (targetBatchContainer) {
          targetBatchContainer.querySelectorAll("flow-video-tile").forEach(triggerTileHover);
          targetBatchContainer.querySelectorAll("video").forEach(checkVideoElement);
        } else {
          document.querySelectorAll("flow-video-tile").forEach(triggerTileHover);
          document.querySelectorAll("flow-video-tile video").forEach(checkVideoElement);
        }
      }
    }, 2000);
  }

  function setupEvents() {
    window.addEventListener("flow-task-media-bound", event => {
      const { submissionId, mediaIds } = event.detail || {};
      const process = window.currentProcess;
      console.log("[FlowUI] 📥 收到 flow-task-media-bound 事件:", { submissionId, mediaIds, currentProcessSubId: process?.submissionId, isRunning: state.isRunning });
      if (!state.isRunning) {
        console.warn("[FlowUI] [media-bound] 忽略: state.isRunning 为 false");
        return;
      }
      if (!process) {
        console.warn("[FlowUI] [media-bound] 忽略: window.currentProcess 为空");
        return;
      }
      if (process.submissionId !== submissionId) {
        console.warn(`[FlowUI] [media-bound] 忽略: submissionId 不匹配 (当前=${process.submissionId}, 事件=${submissionId})`);
        return;
      }
      const binding = state.tasks[process.rowIndex]?.mediaBindings?.[process.lineIndex];
      if (binding?.submissionId !== submissionId) {
        console.warn(`[FlowUI] [media-bound] 忽略: 存储的 binding.submissionId (${binding?.submissionId}) 与事件 (${submissionId}) 不匹配`);
        return;
      }
      binding.mediaIds = [...new Set(mediaIds.filter(id => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id)))];
      console.log(`[FlowUI] ✅ [media-bound] 成功绑定媒体 ID 到任务: Row=${process.rowIndex}, Line=${process.lineIndex}, mediaIds=`, binding.mediaIds);
      saveState();
    });
    window.addEventListener("flow-task-binding-missing", event => {
      const process = window.currentProcess;
      console.warn("[FlowUI] ⚠️ 收到 flow-task-binding-missing 事件:", event.detail);
      if (!state.isRunning || !process || process.submissionId !== event.detail?.submissionId) {
        console.log("[FlowUI] [binding-missing] 忽略: 不属于当前活跃任务");
        return;
      }
      const binding = state.tasks[process.rowIndex]?.mediaBindings?.[process.lineIndex];
      if (binding?.mediaIds.length) {
        console.log("[FlowUI] [binding-missing] 忽略: 当前任务已有已绑定的 mediaIds:", binding.mediaIds);
        return;
      }
      console.error(`[FlowUI] ❌ [binding-missing] 生成响应未解析到可验证的媒体 ID，停止批量任务！Row=${process.rowIndex}, Line=${process.lineIndex}`);
      updateLineStatus(process.rowIndex, process.lineIndex, "failed", "生成响应未解析到可验证的媒体 ID，队列已停止，未下载其他视频。需要检查生成接口响应。");
      stopBatch();
    });
    window.addEventListener("flow-task-media-ready", async event => {
      const { mediaId, url } = event.detail || {};
      console.log(`[FlowUI] 📥 收到 flow-task-media-ready 事件: mediaId=${mediaId}, url=${url?.substring(0, 100)}`);
      const match = findMediaBinding(mediaId);
      if (!match) {
        console.warn(`[FlowUI] [media-ready] 未找到匹配的任务绑定! mediaId=${mediaId}. 当前各行绑定快照:`, state.tasks.map((t, i) => ({ rowIndex: i, bindings: t.mediaBindings })));
        return;
      }
      const parsedId = mediaIdFromVideoUrl(url);
      if (parsedId !== mediaId) {
        console.warn(`[FlowUI] [media-ready] URL 解析出的 ID (${parsedId}) 与 mediaId (${mediaId}) 不一致! 忽略此事件`);
        return;
      }
      console.log(`[FlowUI] 🎯 [media-ready] 匹配到行 Row=${match.rowIndex}, Line=${match.lineIndex}, 添加至 readyIds 并触发下载...`);
      if (!match.binding.readyIds.includes(mediaId)) match.binding.readyIds.push(mediaId);
      match.binding.urls = match.binding.urls || {};
      match.binding.urls[mediaId] = url;
      await saveState();
      await triggerAutoDownload(url, mediaId);
    });
    setupDomVideoWatcher();
  }

  // ----------------------------------------------------
  // 9. 辅助工具方法
  // ----------------------------------------------------
  function splitTextToLines(text) {
    return text ? text.split("\n").map(l => l.trim()).filter(Boolean) : [];
  }

  function calculateDuration(text) {
    const len = text.length;
    if (len <= state.settings.maxLetterFor4s) return 4;
    if (len <= state.settings.maxLetterFor6s) return 6;
    return 8;
  }

  function parsePreset(presetContent) {
    if (!presetContent) return { before: "", after: "" };
    const matches = [...presetContent.matchAll(/\n+/g)];
    if (matches.length === 0) return { before: presetContent, after: "" };
    const longest = matches.reduce((max, curr) => curr[0].length > max[0].length ? curr : max);
    const index = longest.index;
    return {
      before: presetContent.substring(0, index).trim(),
      after: presetContent.substring(index + longest[0].length).trim()
    };
  }

  function getProjectName() {
    try {
      const inputEl = document.querySelector("flow-editable-text input.editable-text-input");
      if (inputEl && inputEl.value) return inputEl.value.trim();
    } catch (e) {}

    const el = document.querySelector("flow-editable-text");
    if (el && el.textContent.trim()) return el.textContent.trim();

    const match = location.pathname.match(/\/project\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];

    if (document.title) {
      const t = document.title.replace(/ - Google Flow.*/i, "").trim();
      if (t && !t.includes("Google Flow")) return t;
    }

    return "Flow_Project";
  }

  function sanitizePathName(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim();
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function extendArray(arr, size, fillValue) {
    const res = [...(arr || [])];
    while (res.length < size) res.push(fillValue);
    if (res.length > size) res.length = size;
    return res;
  }

  function updateLineStatus(rowIndex, lineIndex, status, message) {
    const task = state.tasks[rowIndex];
    if (task) {
      task.status[lineIndex] = status;
      task.message[lineIndex] = message;
      saveState();
      
      const rows = document.querySelectorAll("#flow-tasks-table tbody tr");
      if (rows && rows[rowIndex]) {
        renderTableStatusCell(rows[rowIndex], task, rowIndex);
      }
    }
  }

  // ----------------------------------------------------
  // 9. 异常活动（安全限制）监测与声光报警逻辑
  // ----------------------------------------------------
  let alarmTimer = null;
  let alarmCountdown = 45;
  let activityCheckInterval = null;

  function checkForUnusualActivity() {
    const text = document.body.innerText || "";
    return text.includes("异常活动") || text.includes("Unusual activity") || text.includes("unusual activity");
  }

  function playAlarmSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playBeep = (freq, startTime, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.35, startTime);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + duration);
      };
      playBeep(880, ctx.currentTime, 0.15);
      playBeep(880, ctx.currentTime + 0.25, 0.15);
    } catch (e) {
      console.warn("[FlowUI] 无法播放报警提示音:", e);
    }
  }

  function startActivityCheck() {
    if (activityCheckInterval) clearInterval(activityCheckInterval);
    activityCheckInterval = setInterval(() => {
      if (state.isRunning && !state.isSuspended) {
        if (checkForUnusualActivity()) {
          handleUnusualActivityDetected();
        }
      }
    }, 1500);
  }

  function stopActivityCheck() {
    if (activityCheckInterval) {
      clearInterval(activityCheckInterval);
      activityCheckInterval = null;
    }
  }

  function handleUnusualActivityDetected() {
    console.warn("[FlowUI] 🚨 触发安全限制警告 (检测到异常活动)！已挂起任务。");
    state.isSuspended = true;
    saveState();
    
    if (alarmDialogEl) {
      alarmDialogEl.style.display = "flex";
    }
    
    playAlarmSound();
    
    alarmCountdown = 45;
    const msgEl = document.getElementById("flow-alarm-message");
    if (msgEl) {
      msgEl.style.color = "#f59e0b";
      msgEl.innerText = `系统将在 ${alarmCountdown} 秒后自动刷新网页以尝试恢复，您也可以立即进行手动处理...`;
    }
    
    if (alarmTimer) clearInterval(alarmTimer);
    alarmTimer = setInterval(() => {
      alarmCountdown--;
      if (alarmCountdown <= 0) {
        clearInterval(alarmTimer);
        console.log("[FlowUI] 安全倒计时结束，执行网页刷新恢复...");
        saveState().then(() => {
          location.reload();
        });
      } else {
        if (msgEl) {
          msgEl.innerText = `系统将在 ${alarmCountdown} 秒后自动刷新网页以尝试恢复，您也可以立即进行手动处理...`;
        }
        if (alarmCountdown % 3 === 0) {
          playAlarmSound();
        }
      }
    }, 1000);
  }

  function pauseAlarmCountdown() {
    if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
    const msgEl = document.getElementById("flow-alarm-message");
    if (msgEl) {
      msgEl.innerText = "倒计时已暂停。请手动消除网页弹窗限制，消除后点击下方“继续运行”。";
      msgEl.style.color = "#10b981";
    }
    showToast("自动刷新倒计时已暂停，等待您的手动处理。");
  }

  function resumeFromAlarm() {
    if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
    if (alarmDialogEl) {
      alarmDialogEl.style.setProperty("display", "none", "important");
    }
    state.isSuspended = false;
    saveState();
    showToast("安全限制挂起解除，继续批量生成...");
    
    if (state.isRunning && !batchPromise) {
      startBatch();
    }
  }

  // ----------------------------------------------------
  // 10. 初始化与断点重载自启动运行
  // ----------------------------------------------------
  async function init() {
    console.log("[FlowUI] DOMContentLoaded 触发，开始正式初始化 init()...");
    createUI();

    // 如果之前在 document_start 时挂在 documentElement 上，移入正式的 document.body
    if (document.body) {
      if (fabEl && fabEl.parentNode !== document.body) {
        document.body.appendChild(fabEl);
      }
      if (overlayEl && overlayEl.parentNode !== document.body) {
        document.body.appendChild(overlayEl);
      }
    }

    setupEvents();

    // 拍摄页面已有展示视频基线快照：把页面初始自带的样例或历史视频全部登记为已存在，严防误下载
    function snapshotExistingVideos() {
      const videos = document.querySelectorAll("video");
      videos.forEach(v => {
        const src = v.getAttribute("src") || v.currentSrc || v.src || v.getAttribute("src");
        if (src) downloadedUrlsSet.add(src);
      });
      console.log(`[FlowUI] 拍摄初始视频快照完成，隔离保护 ${videos.length} 个页面已有视频`);
    }
    snapshotExistingVideos();
    window.addEventListener("load", () => snapshotExistingVideos());

    // 立即启动单页应用保活检查：防止 Google Flow 路由二次重绘冲掉挂载在 body 上的 FAB
    setInterval(() => {
      createUI();
    }, 1500);

    // 加载先前保存的状态
    await loadState();
    
    // 如果网页刚才由于刷新中断且处于 Running 状态，则自动断点续跑启动批量任务
    if (state.isRunning) {
      console.log("[FlowUI] 检测到批量运行状态为 TRUE，自动恢复运行断点续传。任务索引:", state.currentIndex, "子行索引:", state.currentLineIndex);
      showToast("正在自动恢复未完成的生成任务，请保持浏览器窗口在前台...");
      
      // 启动安全监测
      startActivityCheck();
      
      // 等待 2.5 秒，保证页面 NextJS 初始化以及 trpc Webpack 完成，然后自启
      setTimeout(() => {
        startBatch();
      }, 2500);
    }
  }

  // 多时机激进挂载：保证在任何阶段都能立即渲染悬浮按钮
  try {
    createUI();
  } catch (e) {
    console.warn("[FlowUI] 首次即时挂载暂缓:", e);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.addEventListener("load", () => createUI());

  console.log("%c[FlowUI] 界面控制器加载完毕！", "background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 4px;");
})();
