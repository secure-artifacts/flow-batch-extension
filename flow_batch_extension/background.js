// background.js - 后台 Service Worker，负责处理下载任务与配置持久化

// 1. 监听来自 content-isolated.js 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download") {
    handleDownload(message.url, message.filename)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // 保持通道开启以进行异步响应
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

// 2. 处理下载逻辑
async function handleDownload(url, filename) {
  try {
    // 规范化文件名中的斜杠，防止创建非法的多层级路径
    const sanitizedFilename = filename.replace(/\/+/g, '/').replace(/^\//, '');
    
    console.log(`[Background] 开始下载视频: URL=${url}, Filename=${sanitizedFilename}`);
    
    return new Promise((resolve) => {
      chrome.downloads.download({
        url: url,
        filename: sanitizedFilename,
        conflictAction: 'uniquify',
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(`[Background] 下载失败:`, chrome.runtime.lastError.message);
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          console.log(`[Background] 下载已启动，ID=${downloadId}`);
          resolve({ success: true, downloadId: downloadId });
        }
      });
    });
  } catch (e) {
    console.error(`[Background] 下载函数捕获到异常:`, e);
    return { error: e.message };
  }
}
