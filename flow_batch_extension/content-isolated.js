// content-isolated.js - 消息桥梁脚本，运行在 ISOLATED 独立世界

// 1. 监听来自 MAIN 网页环境的 window.postMessage 消息
window.addEventListener("message", (event) => {
  // 安全校验：只处理当前 window 发送、且指定 sender 为 "flow-main" 的消息
  if (event.source !== window || !event.data || event.data.sender !== "flow-main") {
    return;
  }

  const { callbackId, payload } = event.data;

  // 2. 将消息透传给插件后台 Service Worker
  chrome.runtime.sendMessage(payload, (response) => {
    // 如果后台在异步通信中由于通道关闭导致无返回，可提供默认错误
    const safeResponse = response || { error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "后台响应超时" };
    
    // 3. 将后台返回的结果通过 postMessage 转发回 MAIN 网页环境
    window.postMessage({
      sender: "flow-isolated",
      callbackId: callbackId,
      response: safeResponse
    }, "*");
  });
});
