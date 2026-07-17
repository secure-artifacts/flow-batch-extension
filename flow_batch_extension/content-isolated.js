// content-isolated.js - 消息桥梁脚本，运行在 ISOLATED 独立世界

// 向后台 Service Worker 发送消息，带有自动重试机制以解决 Service Worker 唤醒延迟/启动失败问题
function sendMessageToBackground(payload, maxRetries = 5, initialDelay = 500) {
  return new Promise((resolve) => {
    let attempt = 0;

    function execute() {
      attempt++;
      
      // 检查当前 context 是否已被销毁（例如扩展重装/重启后旧标签页的脚本）
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.error(`[FlowIsolated] 插件上下文已失效（Orphaned Content Script）。请手动刷新页面。`);
        resolve({ error: "插件上下文已失效，请刷新页面重新连接。" });
        return;
      }

      try {
        chrome.runtime.sendMessage(payload, (response) => {
          // 检查是否有错误
          const lastError = chrome.runtime.lastError;
          
          if (lastError) {
            const errorMsg = lastError.message || "";
            console.warn(`[FlowIsolated] 发送消息失败 (尝试 ${attempt}/${maxRetries}): ${errorMsg}`);

            // 如果是上下文失效相关的错误，重试无意义，直接返回提示刷新
            if (errorMsg.includes("context invalidated") || errorMsg.includes("Extension context invalidated")) {
              resolve({ error: "插件上下文失效，请刷新页面重新连接: " + errorMsg });
              return;
            }

            // 如果还没达到最大重试次数，进行延迟重试
            if (attempt < maxRetries) {
              const nextDelay = initialDelay * Math.pow(2, attempt - 1); // 指数退避: 500ms, 1000ms, 2000ms, 4000ms...
              console.log(`[FlowIsolated] 将在 ${nextDelay}ms 后尝试重新发送消息...`);
              setTimeout(execute, nextDelay);
            } else {
              // 达到最大重试次数，返回错误
              resolve({ error: `连接后台失败 (重试 ${maxRetries} 次): ${errorMsg}` });
            }
          } else {
            // 成功获取响应
            resolve(response || { success: true });
          }
        });
      } catch (e) {
        console.error(`[FlowIsolated] sendMessage 捕获到异常 (尝试 ${attempt}/${maxRetries}):`, e);
        const errorMsg = e.message || "";
        
        if (errorMsg.includes("context invalidated") || errorMsg.includes("Extension context invalidated")) {
          resolve({ error: "插件上下文失效，请刷新页面重新连接: " + errorMsg });
          return;
        }

        if (attempt < maxRetries) {
          const nextDelay = initialDelay * Math.pow(2, attempt - 1);
          setTimeout(execute, nextDelay);
        } else {
          resolve({ error: `发送消息异常: ${errorMsg}` });
        }
      }
    }

    execute();
  });
}

// 1. 监听来自 MAIN 网页环境的 window.postMessage 消息
window.addEventListener("message", (event) => {
  // 安全校验：只处理当前 window 发送、且指定 sender 为 "flow-main" 的消息
  if (event.source !== window || !event.data || event.data.sender !== "flow-main") {
    return;
  }

  const { callbackId, payload } = event.data;

  // 2. 将消息使用重试机制透传给插件后台 Service Worker
  sendMessageToBackground(payload).then((safeResponse) => {
    // 3. 将后台返回的结果通过 postMessage 转发回 MAIN 网页环境
    window.postMessage({
      sender: "flow-isolated",
      callbackId: callbackId,
      response: safeResponse
    }, "*");
  });
});
