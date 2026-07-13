// injects/ui.js - 核心 UI 渲染及批量生成自动化控制脚本 (支持手动 JSON 导出对接与断点重载刷新)

(function() {
  "use strict";

  console.log("[FlowUI] 界面控制器正在初始化...");

  // ----------------------------------------------------
  // 1. 消息中间件（使用 window.postMessage 桥接后台）
  // ----------------------------------------------------
  const extensionCallbacks = new Map();

  function sendToExtension(action, data) {
    return new Promise((resolve) => {
      const callbackId = Math.random().toString(36).substring(2, 9);
      extensionCallbacks.set(callbackId, resolve);
      window.postMessage({
        sender: "flow-main",
        callbackId: callbackId,
        payload: { action, ...data }
      }, "*");
    });
  }

  // 监听来自 content-isolated.js 的响应
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.sender !== "flow-isolated") {
      return;
    }
    const { callbackId, response } = event.data;
    if (extensionCallbacks.has(callbackId)) {
      extensionCallbacks.get(callbackId)(response);
      extensionCallbacks.delete(callbackId);
    }
  });

  // ----------------------------------------------------
  // 2. 状态管理与配置项
  // ----------------------------------------------------
  let state = {
    tasks: [],             // 批量生成任务列表 (含 prompt, mode, image_name, local_image_path, duration, download_path, status, message, downloaded)
    taskRecord: {},        // mediaName -> 任务进度关联信息映射表
    settings: {
      interval: 20,        // 每次生成的间隔基数(秒)
      intervalRandom: 10,  // 随机抖动上限(秒)
      maxLetterFor4s: 40,  // 4s视频最大字数
      maxLetterFor6s: 60,  // 6s视频最大字数
      defaultCount: 1,     // 默认生成数量
      footageType: "VIDEO_FRAMES" // 默认素材类型
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
      [`isRunning_${key}`]: state.isRunning,
      [`currentIndex_${key}`]: state.currentIndex,
      [`currentLineIndex_${key}`]: state.currentLineIndex,
      [`retryCount_${key}`]: state.retryCount
    };
    
    await sendToExtension("setStorage", { data: dataToSave });
  }

  // 从 Storage 读取配置和状态
  async function loadState() {
    const key = getStorageKey();
    state.activeProjectId = key;
    
    const saved = await sendToExtension("getStorage", {
      keys: [
        `tasks_${key}`, "settings", "presets", `taskRecord_${key}`,
        `isRunning_${key}`, `currentIndex_${key}`, `currentLineIndex_${key}`, `retryCount_${key}`
      ]
    });
    
    if (saved) {
      if (saved[`tasks_${key}`]) state.tasks = saved[`tasks_${key}`];
      if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
      if (saved.presets) state.presets = saved.presets;
      if (saved[`taskRecord_${key}`]) state.taskRecord = saved[`taskRecord_${key}`];
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
    if (document.getElementById("flow-batch-fab")) return;

    // 创建悬浮按钮 FAB
    fabEl = document.createElement("div");
    fabEl.id = "flow-batch-fab";
    fabEl.title = "打开批量生成助手";
    fabEl.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
      </svg>
    `;
    document.body.appendChild(fabEl);

    // 创建控制面板遮罩层
    overlayEl = document.createElement("div");
    overlayEl.id = "flow-batch-overlay";
    overlayEl.innerHTML = `
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
                  <th style="width: 80px;">图片</th>
                  <th>提示词文本 (分行分割)</th>
                  <th style="width: 130px;">提示词模板</th>
                  <th style="width: 120px;">素材类型</th>
                  <th style="width: 70px;">生成数</th>
                  <th style="width: 150px;">状态与日志</th>
                  <th style="width: 60px;">操作</th>
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
            <button class="flow-btn secondary" id="btn-clear-tasks" style="color: #ef4444; border-color: rgba(239,68,68,0.2);">
              清空任务
            </button>
          </div>
          <div class="footer-actions-right">
            <button class="flow-btn danger" id="btn-stop-batch" style="display: none;">
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
    `;
    document.body.appendChild(overlayEl);

    // 创建粘贴导入弹窗
    importDialogEl = document.createElement("div");
    importDialogEl.id = "flow-import-dialog";
    importDialogEl.innerHTML = `
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
    `;
    document.body.appendChild(importDialogEl);

    // 创建异常活动报警弹窗
    alarmDialogEl = document.createElement("div");
    alarmDialogEl.id = "flow-alarm-dialog";
    alarmDialogEl.style.cssText = "display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(220, 38, 38, 0.15); backdrop-filter: blur(12px); z-index: 100010; align-items: center; justify-content: center;";
    alarmDialogEl.innerHTML = `
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
    `;
    document.body.appendChild(alarmDialogEl);

    // 创建 Toast 元素
    const toast = document.createElement("div");
    toast.id = "flow-batch-toast";
    toast.className = "flow-toast";
    document.body.appendChild(toast);

    // 绑定基础 UI 事件
    fabEl.addEventListener("click", () => openPanel());
    document.getElementById("flow-panel-close").addEventListener("click", () => closePanel());
    overlayEl.addEventListener("click", (e) => {
      if (e.target === overlayEl) closePanel();
    });

    // 绑定数据导入/导出/加载按钮
    document.getElementById("btn-load-images").addEventListener("click", () => loadPageImages());
    document.getElementById("btn-open-import").addEventListener("click", () => openImportDialog());
    document.getElementById("btn-import-cancel").addEventListener("click", () => closeImportDialog());
    document.getElementById("btn-import-confirm").addEventListener("click", () => handleJSONImport());
    document.getElementById("btn-copy-report").addEventListener("click", () => copyExecutionReport());
    
    document.getElementById("btn-alarm-manual").addEventListener("click", () => pauseAlarmCountdown());
    document.getElementById("btn-alarm-reload").addEventListener("click", () => {
      if (alarmTimer) clearInterval(alarmTimer);
      saveState().then(() => location.reload());
    });
    document.getElementById("btn-alarm-resume").addEventListener("click", () => resumeFromAlarm());
    
    document.getElementById("btn-clear-tasks").addEventListener("click", () => {
      if (confirm("确定清空当前所有生成任务吗？")) {
        state.tasks = [];
        state.currentIndex = 0;
        state.currentLineIndex = 0;
        state.retryCount = 0;
        renderTable();
        saveState();
      }
    });

    document.getElementById("btn-start-batch").addEventListener("click", () => startBatch());
    document.getElementById("btn-stop-batch").addEventListener("click", () => stopBatch());

    bindSettingsEvents();
  }

  function showToast(message, duration = 3000) {
    const el = document.getElementById("flow-batch-toast");
    if (!el) return;
    el.innerText = message;
    el.classList.add("show");
    setTimeout(() => {
      el.classList.remove("show");
    }, duration);
  }

  async function openPanel() {
    overlayEl.classList.add("active");
    await loadState();
    
    // 同步设置项输入框
    document.getElementById("cfg-interval").value = state.settings.interval;
    document.getElementById("cfg-random").value = state.settings.intervalRandom;
    document.getElementById("cfg-max4s").value = state.settings.maxLetterFor4s;
    document.getElementById("cfg-max6s").value = state.settings.maxLetterFor6s;
    
    renderTable();
    renderPresetsList();
  }

  function closePanel() {
    overlayEl.classList.remove("active");
  }

  function openImportDialog() {
    importDialogEl.classList.add("active");
    document.getElementById("flow-import-textarea").value = "";
  }

  function closeImportDialog() {
    importDialogEl.classList.remove("active");
  }

  function bindSettingsEvents() {
    const syncSetting = (elementId, settingKey) => {
      document.getElementById(elementId).addEventListener("change", (e) => {
        state.settings[settingKey] = parseInt(e.target.value, 10) || state.settings[settingKey];
        saveState();
      });
    };

    syncSetting("cfg-interval", "interval");
    syncSetting("cfg-random", "intervalRandom");
    syncSetting("cfg-max4s", "maxLetterFor4s");
    syncSetting("cfg-max6s", "maxLetterFor6s");

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
    container.innerHTML = "";
    state.presets.forEach((preset, index) => {
      const item = document.createElement("div");
      item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:6px 12px; border-radius:6px; border:1px solid var(--flow-border-glass);";
      item.innerHTML = `
        <span style="font-size:12px; font-weight:500;">${preset.name}</span>
        <button class="flow-btn secondary" style="font-size:10px; padding:4px 8px; color:#ef4444; border-color:rgba(239,68,68,0.2);" data-idx="${index}">删除</button>
      `;
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
  // 获取当前 Flow 合集/项目页面的所有已上传素材列表
  function getLoadedPageImages() {
    let images = [];
    try {
      const workflowsStore = window.require("workflows");
      if (workflowsStore && typeof workflowsStore.getState === "function") {
        const allWorkflows = workflowsStore.getState()?.workflows;
        if (allWorkflows) {
          const colId = location.href.match(/\/collection\/([^/]+)/)?.[1];
          images = [...allWorkflows.values()]
            .filter(item => !item.isArchived && (!colId || item.collectionId?.replace("fe_id_", "") === colId))
            .map(item => ({
              id: item.id,
              primaryMediaKey: item.primaryMediaKey || ("fe_id_" + item.id),
              displayName: item.displayName || "未命名图片"
            }));
        }
      }
    } catch (e) {
      console.warn("[FlowUI] 无法从 webpack 状态获取图片，尝试读取 DOM 树:", e);
    }

    if (!images.length) {
      document.querySelectorAll("span>div[data-tile-id]:not(:has(video))").forEach(tile => {
        const tileId = tile.dataset.tileId;
        const img = tile.querySelector("img");
        const nameEl = tile.querySelector("div:not(:has(i))");
        const imgNameMatch = img?.src?.match(/name=([0-9a-z-]+)/);
        if (tileId && imgNameMatch && nameEl) {
          images.push({
            id: tileId,
            primaryMediaKey: "fe_id_" + imgNameMatch[1],
            displayName: nameEl.textContent.trim()
          });
        }
      });
    }
    return images;
  }

  function loadPageImages() {
    const images = getLoadedPageImages();
    if (!images.length) {
      showToast("页面上未识别到任何候选图片原料，请确保进入项目或合集视图。");
      return;
    }

    const addedImageIds = new Set(state.tasks.map(t => t.image.id));
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

    if (newTasks.length > 0) {
      state.tasks = [...state.tasks, ...newTasks];
      renderTable();
      saveState();
      showToast(`成功加载并新增了 ${newTasks.length} 个图片任务`);
    } else {
      showToast("所有页面图片都已在列表中。");
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

    const loadedImages = getLoadedPageImages();
    console.log("[FlowUI] 正在导入 JSON，当前页面识别到的图片列表为:", loadedImages);
    
    // 辅助清除后缀、空白与转小写的比对器
    const cleanNameHelper = (name) => {
      if (!name) return "";
      return name.replace(/\.(png|jpg|jpeg|webp|gif|bmp|mp4)$/i, "").trim().toLowerCase();
    };

    let importCount = 0;
    let missingImagesCount = 0;

    parsedList.forEach(item => {
      const prompt = item.prompt || "";
      const mode = item.mode || "VIDEO_FRAMES";
      const duration = item.duration || 6;
      const downloadPath = item.download_path || "";
      const imageName = item.image_name || "";
      const localImagePath = item.local_image_path || "";

      // 图片查找匹配逻辑：
      // 1. 优先使用清除后缀后的 image_name 比对
      // 2. 次优提取 local_image_path 中的文件名清除后缀比对
      // 3. 支持包含关系比对 (如 page中有 "cat" 而 json里是 "cat.png")
      let matchedImg = null;
      const targetName = cleanNameHelper(imageName);
      const targetLocalName = cleanNameHelper(getFilenameFromPath(localImagePath));

      if (targetName || targetLocalName) {
        matchedImg = loadedImages.find(img => {
          const pageName = cleanNameHelper(img.displayName);
          return (targetName && pageName === targetName) ||
                 (targetLocalName && pageName === targetLocalName) ||
                 (targetName && (pageName.includes(targetName) || targetName.includes(pageName))) ||
                 (targetLocalName && (pageName.includes(targetLocalName) || targetLocalName.includes(pageName)));
        });
      }

      console.log("[FlowUI] 匹配比对详情:", {
        输入图名: imageName,
        输入本地路径: localImagePath,
        匹配目标清理: { targetName, targetLocalName },
        匹配结果: matchedImg ? matchedImg.displayName : "未找到"
      });

      let finalTaskImage = null;
      let statusList = [];
      let messageList = [];

      if (matchedImg) {
        finalTaskImage = matchedImg;
        statusList = ["pending"];
        messageList = ["等待批量调度"];
      } else {
        // 未在页面上找到对应的图片原料，依然创建该任务，但标红报错
        finalTaskImage = {
          id: null,
          primaryMediaKey: null,
          displayName: imageName || getFilenameFromPath(localImagePath) || "未识别图片"
        };
        statusList = ["failed"];
        messageList = ["网页素材库中未找到同名图片，请先上传"];
        missingImagesCount++;
      }

      state.tasks.push({
        image: finalTaskImage,
        text: prompt,
        preset: "无模版(直接填入)", // 导入的数据直接自带拼好的词或选择直填
        footageType: mode,
        count: 1, // 默认生成 1 个
        status: statusList,
        message: messageList,
        downloaded: [false],
        download_path: downloadPath, // 记录绝对保存路径
        duration: duration           // 保存设置的秒数
      });
      importCount++;
    });

    closeImportDialog();
    renderTable();
    saveState();
    
    let reportMsg = `导入完毕！成功解析了 ${importCount} 个任务配置。`;
    if (missingImagesCount > 0) {
      reportMsg += `\n其中有 ${missingImagesCount} 个任务因“图片未上传/未找到”报错，请先将其上传到 Flow 项目中再点击重置。`;
    }
    alert(reportMsg);
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
    tbody.innerHTML = "";

    if (!state.tasks.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--flow-text-secondary); padding: 40px 0;">
            暂无任务。请点击“导入外部 JSON”粘贴任务数据，或点击“加载页面图片”直接导入当前网页上的原料。
          </td>
        </tr>
      `;
      return;
    }

    state.tasks.forEach((task, rowIndex) => {
      const tr = document.createElement("tr");
      
      // 1. 图片预览列
      const imgTd = document.createElement("td");
      if (task.image.primaryMediaKey) {
        const imgUrl = `/fx/api/trpc/media.getMediaUrlRedirect?name=${task.image.primaryMediaKey.replace("fe_id_", "")}`;
        imgTd.innerHTML = `
          <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
            <img class="cell-image-preview" src="${imgUrl}" alt="Preview" />
            <span style="font-size:11px; max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${task.image.displayName}">${task.image.displayName}</span>
          </div>
        `;
      } else {
        imgTd.innerHTML = `
          <div style="display:flex; flex-direction:column; align-items:center; gap:4px; color:#ef4444;">
            <div style="width:50px; height:50px; border-radius:8px; border:1px dashed #ef4444; display:flex; align-items:center; justify-content:center; font-size:20px;">?</div>
            <span style="font-size:11px; max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${task.image.displayName}">${task.image.displayName}</span>
          </div>
        `;
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
      typeSelect.innerHTML = `
        <option value="VIDEO_FRAMES">帧模式 (默认)</option>
        <option value="VIDEO_REFERENCES">素材模式</option>
      `;
      typeSelect.value = task.footageType;
      typeSelect.addEventListener("change", (e) => {
        task.footageType = e.target.value;
        saveState();
      });
      typeTd.appendChild(typeSelect);
      tr.appendChild(typeTd);

      // 5. 生成数数量列
      const countTd = document.createElement("td");
      const countSelect = document.createElement("select");
      countSelect.className = "cell-select";
      countSelect.style.width = "60px";
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

      // 7. 操作删除列
      const actionTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "flow-btn secondary";
      delBtn.style.padding = "6px 12px";
      delBtn.style.color = "#ef4444";
      delBtn.style.borderColor = "rgba(239,68,68,0.1)";
      delBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      `;
      delBtn.addEventListener("click", () => {
        state.tasks.splice(rowIndex, 1);
        renderTable();
        saveState();
      });
      actionTd.appendChild(delBtn);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });
  }

  function renderTableStatusCell(rowElement, task, rowIndex) {
    const container = rowElement.querySelector(".status-cell-container");
    if (!container) return;
    
    container.innerHTML = "";
    const lines = splitTextToLines(task.text);
    
    if (lines.length === 0) {
      container.innerHTML = `<span style="color: var(--flow-text-secondary); font-size:12px;">待输入文本</span>`;
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex; flex-direction:column; gap:6px; max-height:80px; overflow-y:auto; padding-right:4px;";
    
    lines.forEach((line, lineIdx) => {
      const status = task.status[lineIdx] || "pending";
      const message = task.message[lineIdx] || "";
      
      const lineRow = document.createElement("div");
      lineRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px;";
      
      let badgeHtml = "";
      if (status === "pending") {
        badgeHtml = `<span class="status-badge pending"><span style="width:6px; height:6px; border-radius:50%; background:#f59e0b; display:inline-block; box-shadow:0 0 6px #f59e0b;"></span>等待</span>`;
      } else if (status === "generating") {
        badgeHtml = `<span class="status-badge generating"><span class="spinner"></span>生成中</span>`;
      } else if (status === "success") {
        badgeHtml = `<span class="status-badge success">✓ 成功</span>`;
      } else if (status === "failed") {
        badgeHtml = `<span class="status-badge failed" title="${message}">✗ 失败</span>`;
      }

      lineRow.innerHTML = `
        <span style="max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--flow-text-secondary);" title="${line}">#${lineIdx+1}: ${line}</span>
        <div style="display:flex; align-items:center; gap:6px;">
          ${badgeHtml}
          ${status !== "pending" && status !== "generating" ? `
            <button class="flow-btn secondary" style="font-size:9px; padding:2px 6px; border-radius:4px;" data-line="${lineIdx}">重置</button>
          ` : ""}
        </div>
      `;

      // 绑定行重置功能
      const resetBtn = lineRow.querySelector("button");
      if (resetBtn) {
        resetBtn.addEventListener("click", (e) => {
          const lIdx = parseInt(e.target.dataset.line, 10);
          task.status[lIdx] = "pending";
          task.message[lIdx] = "已手动重置";
          task.downloaded[lIdx] = false;
          saveState();
          renderTableStatusCell(rowElement, task, rowIndex);
        });
      }

      wrapper.appendChild(lineRow);
    });

    container.appendChild(wrapper);
  }

  // ----------------------------------------------------
  // 7. 自动化批量生成主线程循环与自动重载刷新
  // ----------------------------------------------------
  let isStopRequested = false;

  async function startBatch() {
    state.isSuspended = false;
    if (alarmDialogEl) alarmDialogEl.style.display = "none";
    if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
    
    // 启动安全限制监测
    startActivityCheck();

    // 首先校验页面元素和 stores 是否就绪
    if (!window.promptBoxStore) {
      state.isRunning = true;
      await saveState();
      
      console.warn("[FlowUI] 检测到 promptBoxStore 暂未就绪，将在 3 秒后重试。若持续无法就绪则自动刷新页面...");
      showToast("正在检测网页环境，请稍候...");
      
      // 循环等待 5 秒
      for (let w = 0; w < 5; w++) {
        await delay(1000);
        if (window.promptBoxStore) break;
      }
      
      if (!window.promptBoxStore) {
        showToast("环境加载异常，自动刷新网页重试中...");
        state.retryCount = (state.retryCount || 0) + 1;
        await saveState();
        location.reload();
        return;
      }
    }

    const validTasks = state.tasks.filter(t => t.image && t.image.primaryMediaKey && splitTextToLines(t.text).length > 0);
    if (!validTasks.length) {
      alert("无可执行生成任务！(可能原因为列表为空、图片匹配失败，或提示词未填)");
      return;
    }

    state.isRunning = true;
    isStopRequested = false;
    
    document.getElementById("btn-start-batch").style.display = "none";
    document.getElementById("btn-stop-batch").style.display = "inline-flex";
    
    showToast("开始自动化批量生成队列...");
    
    const intervalSec = state.settings.interval;
    const intervalRand = state.settings.intervalRandom;

    // 读取存储中的断点索引继续运行，实现断点续跑
    for (let rIdx = state.currentIndex || 0; rIdx < state.tasks.length; rIdx++) {
      state.currentIndex = rIdx;
      await saveState();

      const task = state.tasks[rIdx];
      const lines = splitTextToLines(task.text);
      if (!task.image || !task.image.primaryMediaKey || !lines.length) continue;

      for (let lIdx = state.currentLineIndex || 0; lIdx < lines.length; lIdx++) {
        state.currentLineIndex = lIdx;
        await saveState();

        if (isStopRequested) {
          showToast("用户中断了批量任务！");
          onBatchFinished();
          return;
        }

        // 跳过已经成功的行
        if (task.status[lIdx] === "success") continue;

        const lineText = lines[lIdx];
        // 允许单个任务有设定好的 duration，否则动态计算
        const duration = task.duration || calculateDuration(lineText);
        const preset = state.presets.find(p => p.name === task.preset);
        const parsedPreset = parsePreset(preset?.content);

        updateLineStatus(rIdx, lIdx, "pending", "排队提交中...");
        
        try {
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
            download_path: task.download_path
          });

          // 成功发出，设置 generating 状态，并归零当前行重试计数
          updateLineStatus(rIdx, lIdx, "generating", "已提交到浏览器生成");
          state.retryCount = 0;
          await saveState();
          
        } catch (err) {
          console.error(`[Batch] 生成触发失败:`, err);
          updateLineStatus(rIdx, lIdx, "failed", err.message);
          
          // 容错刷新自动重试：如果失败，刷新页面再次尝试
          state.retryCount = (state.retryCount || 0) + 1;
          if (state.retryCount <= 3) {
            showToast(`生成异常：${err.message}，正在刷新网页并进行第 ${state.retryCount} 次重试...`);
            await saveState();
            await delay(1000);
            location.reload();
            return;
          } else {
            console.error(`已连续重试 3 次均失败，跳过该项`);
            updateLineStatus(rIdx, lIdx, "failed", "超过最大重试次数: " + err.message);
            state.retryCount = 0;
            await saveState();
          }
        }

        // 清理行内继续的指针，方便下一个任务从 0 行开始跑
        state.currentLineIndex = 0;
        await saveState();

        // 批量间隔延时
        const waitTime = intervalSec + Math.random() * intervalRand;
        console.log(`[Batch] 等待间隔延迟: ${waitTime.toFixed(1)} 秒`);
        for (let i = 0; i < waitTime; i++) {
          if (isStopRequested) break;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    showToast("所有队列任务的批量生成提交已完成！");
    onBatchFinished();
  }

  function stopBatch() {
    isStopRequested = true;
    stopActivityCheck();
    state.isRunning = false;
    saveState();
    showToast("正在请求停止生成...");
  }

  function onBatchFinished() {
    stopActivityCheck();
    
    state.isRunning = false;
    state.currentIndex = 0;
    state.currentLineIndex = 0;
    state.retryCount = 0;
    
    document.getElementById("btn-start-batch").style.display = "inline-flex";
    document.getElementById("btn-stop-batch").style.display = "none";
    
    window.currentProcess = null;
    saveState();
  }

  // 模拟操作 React/Next.js store 填入提示词和点击生成
  async function submitTaskToPage(params) {
    const { image, lineText, presetBefore, presetAfter, footageType, count, duration, rowIndex, lineIndex } = params;
    
    window.currentProcess = params;

    // 1. 清空页面原有的输入数据
    window.promptBoxStore.getState().actions.clearPromptBox();
    await delay(300);

    // 2. 配置视频模型参数与秒数
    const modeVal = footageType || "VIDEO_FRAMES";
    window.promptBoxStore.setState({
      mode: modeVal,
      aspectRatio: "PORTRAIT", 
      outputsPerPrompt: count || 1,
      videoModelFamilyId: "veo_3_1_lite_low_priority", 
      selectedVideoDuration: duration
    });
    await delay(300);

    // 3. 将参考图片注入
    window.promptBoxStore.getState().actions.addImageIngredient({
      imageId: image.primaryMediaKey,
      preferredIngredientType: modeVal === "VIDEO_FRAMES" ? "FIRST_FRAME" : "REFERENCE",
      source: "PLUS_BUTTON"
    });
    await delay(300);

    // 4. 拼装拼接后的提示词
    const finalPrompt = `${presetBefore}\n${lineText}\n${presetAfter}`.trim();
    window.promptBoxStore.getState().actions.setPrompt(finalPrompt);
    await delay(300);

    // 5. 触发生成事件
    if (typeof window.generateVideo === "function") {
      window.generateVideo();
    } else {
      throw new Error("全局 generateVideo 生成器方法未就绪");
    }
  }

  // ----------------------------------------------------
  // 8. 拦截事件监听与自动下载
  // ----------------------------------------------------
  function setupEvents() {
    // 监听 onSubmitSuccess (trpc 请求已经发送并且获得了 mediaId 数组)
    window.addEventListener("flow-onSubmitSuccess", (e) => {
      const nameToProcessMap = e.detail;
      console.log("[FlowUI] 收到 onSubmitSuccess 事件:", nameToProcessMap);
      state.taskRecord = { ...state.taskRecord, ...nameToProcessMap };
      saveState();
    });

    // 监听 onReceiveData (轮询接口返回生成状态为 SUCCESSFUL)
    window.addEventListener("flow-onReceiveData", async (e) => {
      const successfulMediaMap = e.detail;
      console.log("[FlowUI] 检测到视频生成成功:", successfulMediaMap);

      const mapEntries = Object.entries(successfulMediaMap);
      for (const [mediaName, urlList] of mapEntries) {
        const processInfo = state.taskRecord[mediaName];
        if (!processInfo) continue;

        const { rowIndex, lineIndex, download_path } = processInfo;
        
        // 移出未完结任务缓冲
        delete state.taskRecord[mediaName];
        saveState();

        let targetDownloadPath = "Flow/";
        if (download_path) {
          const parts = download_path.replace(/\\/g, "/").split("/");
          const filename = parts[parts.length - 1] || "video.mp4";
          
          // 通过斜杠切割后的固定层级数获取项目名：
          // 倒数第 1 项是 22.mp4 (filename)
          // 倒数第 2 项是 videos
          // 倒数第 3 项是 downloads
          // 倒数第 4 项即为项目文件夹名 (例如 "01_车里，已检查-flow")
          let projectName = "";
          if (parts.length >= 4) {
            projectName = parts[parts.length - 4];
          } else {
            projectName = parts[parts.length - 2] || "UntitledProject";
          }
          
          // 格式化生成的文件名: 文件夹名 + '_' + 原视频文件名 (例如 "01_车里，已检查-flow_22.mp4")
          const cleanProject = sanitizePathName(projectName);
          const extIndex = filename.lastIndexOf(".");
          const ext = extIndex !== -1 ? filename.substring(extIndex) : ".mp4";
          const filenameNoExt = extIndex !== -1 ? filename.substring(0, extIndex) : filename;
          
          const finalFilename = `${cleanProject}_${filenameNoExt}${ext}`;
          targetDownloadPath += `${cleanProject}/${finalFilename}`;
        } else {
          // 降级使用工程默认生成路径命名
          const projectName = getProjectName();
          const cleanImgName = processInfo.image.displayName.replace(/\.\w*$/, "");
          targetDownloadPath += `${sanitizePathName(projectName)}/${cleanImgName}-${lineIndex + 1}.mp4`;
        }

        for (const urlObj of urlList) {
          console.log(`[FlowUI] 自动下载: URL=${urlObj.url}, Path=${targetDownloadPath}`);
          
          const dlResult = await sendToExtension("download", {
            url: urlObj.url,
            filename: targetDownloadPath
          });

          if (dlResult && dlResult.success) {
            updateLineStatus(rowIndex, lineIndex, "success", "下载已发送");
          } else {
            const errorMsg = dlResult?.error || "下载请求被拦截";
            updateLineStatus(rowIndex, lineIndex, "failed", errorMsg);
          }
        }
      }
    });
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
      const projStore = window.require("projectDetails");
      if (projStore && typeof projStore.getState === "function") {
        const details = projStore.getState()?.projectDetails;
        if (details && details.name) return details.name;
      }
    } catch (e) {}
    const headerInput = document.querySelector("#flow-desktop-header input[type=text]:not([data-testid=search-input])");
    return headerInput ? headerInput.value.trim() : "未命名项目";
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
      alarmDialogEl.style.display = "none";
    }
    state.isSuspended = false;
    saveState();
    showToast("安全限制挂起解除，继续批量生成...");
    
    if (state.isRunning) {
      startBatch();
    }
  }

  // ----------------------------------------------------
  // 10. 初始化与断点重载自启动运行
  // ----------------------------------------------------
  async function init() {
    createUI();
    setupEvents();
    
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

  // 开始初始化加载
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  console.log("[FlowUI] 界面控制器加载完毕。");
})();
