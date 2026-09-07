// background.js - 后台 Service Worker，负责处理下载任务、路径重定向与配置持久化

// 1. 监听来自 content-isolated.js 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 兼容旧桥接消息；不再用全局当前任务重命名任何下载。
  if (["setActiveTask", "clearActiveTask"].includes(message.action)) {
    sendResponse({ success: true });
    return;
  }

  console.log(`[Background] 📥 收到来自 content-isolated 的消息: action=${message.action}`, message);

  if (message.action === "download") {
    handleDownload(message.url, message.filename, { ...message.task, tabId: sender.tab?.id, frameId: sender.frameId })
      .then(result => {
        console.log(`[Background] handleDownload 处理完毕返回:`, result);
        sendResponse(result);
      })
      .catch(err => {
        console.error(`[Background] handleDownload 处理异常:`, err);
        sendResponse({ error: err.message });
      });
    return true; // 保持通道开启以进行异步响应
  }

  if (message.action === "getDownloadStatus") {
    chrome.downloads.search({ id: message.downloadId }).then(items => {
      const item = items[0];
      console.log(`[Background] 查询 downloadId=${message.downloadId} 结果:`, item ? { state: item.state, error: item.error } : "不存在");
      sendResponse(item ? { state: item.state, error: item.error } : { error: "下载记录不存在" });
    }).catch(err => {
      console.error(`[Background] 查询 downloadId=${message.downloadId} 失败:`, err);
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.action === "getStorage") {
    chrome.storage.local.get(message.keys, (result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.action === "setStorage") {
    chrome.storage.local.set(message.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// 2. 处理直接下载逻辑
async function handleDownload(url, filename, task) {
  try {
    console.log(`[Background] 🎬 handleDownload 启动: URL=${url}, Filename=${filename}, task=`, task);
    // 规范化文件名中的斜杠，防止创建非法的多层级路径
    if (!task?.mediaId || !task.submissionId || !task.taskId || !filename || filename !== task.download_path) {
      console.error("[Background] ❌ 拒绝下载: 缺少媒体 ID 或任务文件名绑定", { task, filename });
      throw new Error("缺少媒体 ID 或任务文件名绑定，拒绝下载");
    }
    const parsed = new URL(url);
    const mediaId = parsed.hostname === "flow-content.google" ? parsed.pathname.match(/^\/video\/([a-zA-Z0-9_-]+)$/)?.[1] :
      parsed.hostname === "labs.google" && parsed.pathname === "/fx/api/trpc/media.getMediaUrlRedirect" ?
        ((parsed.searchParams.get("name") || "").split("/media/").pop().replace(/^media\//, "")) : null;
    console.log(`[Background] URL 解析出的 mediaId: ${mediaId}, task.mediaId: ${task.mediaId}`);
    if (mediaId !== task.mediaId) {
      console.error(`[Background] ❌ 拒绝下载: 下载地址的媒体 ID (${mediaId}) 与任务 (${task.mediaId}) 不一致`);
      throw new Error("下载地址的媒体 ID 与任务不一致");
    }
    const sanitizedFilename = filename.replace(/\\/g, "/").replace(/^\/+/, "");
    if (sanitizedFilename.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*]/.test(part))) {
      console.error(`[Background] ❌ 拒绝下载: 文件名包含非法字符: ${sanitizedFilename}`);
      throw new Error("下载文件名无效");
    }
    // 在 Chrome 触发文件命名事件之前保存这个 URL 的独立文件名。
    await chrome.storage.session.set({ [`filename_${url}`]: sanitizedFilename });
    console.log(`[Background] 🚀 开始调用 Chrome API 下载视频: URL=${url}, Filename=${sanitizedFilename}`);
    
    return new Promise((resolve) => {
      chrome.downloads.download({
        url: url,
        filename: sanitizedFilename,
        conflictAction: 'uniquify',
        saveAs: false
      }, async (downloadId) => {
        try {
        if (chrome.runtime.lastError) {
          console.error(`[Background] ❌ chrome.downloads.download 失败:`, chrome.runtime.lastError.message);
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          console.log(`[Background] ✅ chrome.downloads.download 已启动，分配 ID=${downloadId}`);
          await chrome.storage.session.set({ [`download_${downloadId}`]: { ...task, filename: sanitizedFilename, url } });
          resolve({ success: true, downloadId: downloadId });
          // 下载可能在关联信息落盘之前就完成。
          const items = await chrome.downloads.search({ id: downloadId });
          if (items[0]?.state === "complete" || items[0]?.state === "interrupted") {
            await notifyDownload(downloadId, items[0].state, items[0].error);
          }
        }
        } catch (err) {
          console.error("[Background] 下载跟踪失败", err);
          resolve({ error: err.message });
        }
      });
    });
  } catch (e) {
    console.error(`[Background] 下载函数捕获到异常:`, e);
    return { error: e.message };
  }
}

// 只处理本扩展发起、精确 URL/下载 ID 已登记的下载。
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
  chrome.storage.session.get([`download_${item.id}`, `filename_${item.url}`]).then(saved => {
    const filename = saved[`download_${item.id}`]?.filename || saved[`filename_${item.url}`];
    console.log(`[Background] 📝 onDeterminingFilename: ID=${item.id}, URL=${item.url}, 匹配目标文件名=${filename}`);
    if (filename) suggest({ filename, conflictAction: "uniquify" });
    else suggest();
  }).catch(() => suggest());
  return true;
});

// 按下载 ID 保存归属，标签页切换或 Service Worker 重启不会串任务。
async function notifyDownload(id, state, error) {
  const key = `download_${id}`;
  const saved = await chrome.storage.session.get(key);
  const task = saved[key];
  if (!task || task.tabId == null) return;
  try {
    console.log(`[Background] 📢 notifyDownload: 通知标签页 tabId=${task.tabId}, downloadId=${id}, state=${state}, error=${error}`);
    await chrome.tabs.sendMessage(task.tabId, {
      action: state === "complete" ? "downloadCompleted" : "downloadFailed",
      downloadId: id, task, error: error || "下载中断"
    }, { frameId: task.frameId ?? 0 });
    await chrome.storage.session.remove(key);
  } catch (err) { console.warn("[Background] 下载通知未送达", err); }
}
chrome.downloads.onChanged.addListener(delta => {
  if (["complete", "interrupted"].includes(delta.state?.current)) {
    console.log(`[Background] 🔄 downloads.onChanged: ID=${delta.id}, state=${delta.state?.current}, error=${delta.error?.current || '无'}`);
    notifyDownload(delta.id, delta.state.current, delta.error?.current);
  }
});
