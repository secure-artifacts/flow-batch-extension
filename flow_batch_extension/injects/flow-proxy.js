// injects/flow-proxy.js - 核心代理拦截脚本，在 document_start 运行于 MAIN 页面上下文

(function() {
  "use strict";
  
  console.log("[FlowProxy] 代理脚本注入成功，正在启动拦截...");

  // ----------------------------------------------------
  // 1. Hook Object.prototype.hasOwnProperty
  // ----------------------------------------------------
  // 通过 Hook hasOwnProperty 拦截 React/Next.js 组件上下文，获取 promptBoxStore 和 onSubmit 方法
  const origHasOwnProperty = Object.prototype.hasOwnProperty;
  Object.prototype.hasOwnProperty = function(prop) {
    const obj = this;
    if (obj && obj.promptBoxStore && obj.onSubmit) {
      window.promptBoxStore = obj.promptBoxStore;
      
      try {
        console.log("[FlowProxy] 成功拦截 promptBoxStore! 动作列表:", Object.keys(obj.promptBoxStore.getState().actions || {}));
        console.log("[FlowProxy] 拦截时 promptBoxStore 的当前状态:", obj.promptBoxStore.getState());
      } catch (err) {
        console.error("[FlowProxy] 打印 promptBoxStore 信息失败:", err);
      }
      
      // 当不是提示词编辑框模式且拥有 placeholder 时，暴露出全局的生成触发方法
      if (!obj.promptBoxId && obj.placeholder) {
        window.generateVideo = () => {
          console.log("[FlowProxy] 触发 window.generateVideo()");
          return obj.onSubmit(true, true);
        };
      }
    }
    return origHasOwnProperty.call(this, prop);
  };

  // ----------------------------------------------------
  // 2. Hook window.fetch 拦截 API 响应
  // ----------------------------------------------------
  window.currentProcess = null; // 由 ui.js 设置，表示当前正在处理的行元数据

  async function parseFetchResponse(response) {
    const contentType = response.headers.get("Content-Type") || "";
    try {
      if (contentType.includes("application/json")) {
        return await response.json();
      } else if (contentType.includes("text/")) {
        let text = await response.text();
        // 剥离 Next.js trpc 的防止 JSON 注入前缀 "for(;;);"
        text = text.replace(/^for\s*\(\s*;;\s*\);/, "").trim();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } else if (contentType.includes("application/octet-stream") || contentType.includes("blob")) {
        return await response.blob();
      } else if (contentType.includes("form-data")) {
        return await response.formData();
      } else {
        let text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    } catch (e) {
      console.error("[FlowProxy] 解析响应失败:", e);
    }
    return null;
  }

  function getUrlString(urlObj) {
    if (typeof urlObj === "string") return urlObj;
    if (urlObj instanceof URL) return urlObj.href;
    if (urlObj instanceof Request) return urlObj.url;
    return String(urlObj ?? "");
  }

  function setupFetchHook() {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = getUrlString(input);
      
      // 判断是否是提交生成视频接口
      const isGenerateRequest = (
        url.includes("video:batchAsyncGenerateVideoStartAndEndImage") ||
        url.includes("video:batchAsyncGenerateVideoStartImage") ||
        url.includes("video:batchAsyncGenerateVideoReferenceImages") ||
        url.includes("video:batchAsyncGenerateVideoText")
      ) && window.currentProcess !== null;

      // 判断是否是轮询查询生成状态的接口
      const isStatusCheckRequest = url.includes("video:batchCheckAsyncVideoGenerationStatus");
      
      if (!isGenerateRequest && !isStatusCheckRequest) {
        return originalFetch.apply(this, arguments);
      }

      return (async () => {
        const response = await originalFetch.apply(this, arguments);
        try {
          const responseClone = response.clone();
          const parsedData = await parseFetchResponse(responseClone);
          
          if (parsedData) {
            if (isGenerateRequest) {
              const mediaList = parsedData.media;
              if (Array.isArray(mediaList) && mediaList.length) {
                const nameToProcessMap = {};
                for (const media of mediaList) {
                  const mediaName = media?.name;
                  if (mediaName) {
                    nameToProcessMap[mediaName] = window.currentProcess;
                  }
                }
                if (Object.keys(nameToProcessMap).length) {
                  console.log("[FlowProxy] 拦截到生成成功启动，关联数据:", nameToProcessMap);
                  // 派发自定义事件，通知 ui.js 记录任务
                  window.dispatchEvent(new CustomEvent("flow-onSubmitSuccess", { detail: nameToProcessMap }));
                }
              }
            } else if (isStatusCheckRequest) {
              const successfulMediaMap = {};
              const mediaList = parsedData.media;
              if (Array.isArray(mediaList) && mediaList.length) {
                for (const media of mediaList) {
                  // 过滤出成功的视频
                  const status = media.mediaMetadata?.mediaStatus?.mediaGenerationStatus?.toUpperCase();
                  if (status && status.includes("SUCCESSFUL")) {
                    const mediaName = media?.name;
                    if (mediaName) {
                      const redirectUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaName}&mediaUrlType=MEDIA_URL_TYPE_FULL_MEDIA`;
                      if (!successfulMediaMap[mediaName]) {
                        successfulMediaMap[mediaName] = [];
                      }
                      successfulMediaMap[mediaName].push({ url: redirectUrl });
                    }
                  }
                }
                if (Object.keys(successfulMediaMap).length) {
                  console.log("[FlowProxy] 拦截到生成成功的状态，链接列表:", successfulMediaMap);
                  // 派发自定义事件，通知 ui.js 启动下载
                  window.dispatchEvent(new CustomEvent("flow-onReceiveData", { detail: successfulMediaMap }));
                }
              }
            }
          }
        } catch (err) {
          console.error("[FlowProxy] 处理拦截响应出错:", err);
        }
        return response;
      })();
    };
  }

  // ----------------------------------------------------
  // 3. Hook webpackChunk_N_E 窃取 React 模块
  // ----------------------------------------------------
  function hookModuleFactory(chunk, index) {
    if (window.modulefactory) return;
    const firstKey = Object.keys(chunk)[0];
    const originalFactory = chunk[firstKey];
    console.log("[FlowProxy] 发现 Webpack 模块加载，开始挂载 modulefactory...");
    chunk[firstKey] = function() {
      window.modulefactory = arguments[2]; // 保存 Webpack module map
      originalFactory.apply(this, arguments);
    };
  }

  const moduleState = { Modules: [] };

  function refreshModules() {
    if (!window.modulefactory) return;
    console.log("[FlowProxy] 刷新模块缓存中...");
    
    moduleState.Modules = Object.keys(window.modulefactory.m).map(id => {
      let moduleExports = null;
      try {
        moduleExports = window.modulefactory(id);
      } catch {}
      return moduleExports;
    });

    const findModule = (predicate) => {
      const results = [];
      moduleState.Modules.forEach(mod => {
        if (typeof mod !== "undefined") {
          if (typeof predicate === "string") {
            if (typeof mod.default === "object") {
              for (const k in mod.default) if (k === predicate) results.push(mod);
            }
            for (const k in mod) if (k === predicate) results.push(mod);
          } else if (typeof predicate === "function") {
            if (predicate(mod)) results.push(mod);
          }
        }
      });
      return results;
    };

    const getModule = (predicate) => {
      const results = [];
      moduleState.Modules.forEach(mod => {
        if (typeof mod !== "undefined") {
          if (typeof predicate === "string") {
            if (typeof mod.default === "object") {
              for (const k in mod.default) if (k === predicate) results.push(mod);
            }
            for (const k in mod) if (k === predicate) results.push(mod);
          } else if (typeof predicate === "function") {
            const mapped = predicate(mod);
            if (mapped) results.push(mapped);
          }
        }
      });
      return results;
    };

    const findFunction = (query) => {
      if (moduleState.Modules.length === 0) throw Error("无模块缓存");
      const results = [];
      if (typeof query === "string") {
        moduleState.Modules.forEach(mod => {
          if (mod.toString().includes(query)) results.push(mod);
        });
      } else if (typeof query === "function") {
        moduleState.Modules.forEach(mod => {
          if (query(mod)) results.push(mod);
        });
      }
      return results;
    };

    window.moduleManager = {
      modules: moduleState.Modules,
      findModule,
      getModule,
      findFunction,
      get: window.modulefactory ? (id => window.modulefactory(id)) : null
    };
  }

  function setupWebpackHook() {
    if (window.webpackChunk_N_E) {
      console.log("[FlowProxy] webpackChunk_N_E 已经存在，将无法自动 hook chunk 加载");
    } else {
      window.webpackChunk_N_E = [];
      const originalPush = window.webpackChunk_N_E.push;
      window.fbmodules = {};
      const pendingModules = {};
      window.replaceIds = [];
      
      const storePredicate = (storeKey) => (mod) => {
        if (typeof mod === "object") {
          for (const k of Object.keys(mod)) {
            try {
              const keys = Object.keys(mod[k]);
              if (keys.includes("getState") && keys.includes("setState") && storeKey in mod[k].getState()) {
                return mod[k];
              }
            } catch {}
          }
        }
      };

      // 暴露全局 require，模拟 CJS 加载核心 React Store
      window.require = function(moduleName) {
        if (!fbmodules[moduleName]) {
          if (!window.moduleManager) return {};
          let targetModule;
          if (["workflows", "projectDetails", "collections"].includes(moduleName)) {
            targetModule = window.moduleManager.getModule(storePredicate(moduleName));
          } else {
            // 如需获取 react, react-dom 等模块
            if (moduleName === "react") {
              targetModule = window.moduleManager.findModule(mod => mod && mod.createElement);
            } else if (moduleName === "react-dom") {
              targetModule = window.moduleManager.findModule(mod => mod && mod.hydrateRoot && mod.render);
            }
          }
          if (!targetModule?.[0]) return {};
          fbmodules[moduleName] = targetModule?.[0];
        }
        return fbmodules[moduleName];
      };

      let pushCount = 0;
      const registeredPushes = { 0: originalPush };
      let refreshTimeout;

      Object.defineProperty(webpackChunk_N_E, "push", {
        get: () => {
          if (pushCount > 0) {
            const currentIdx = pushCount;
            return function() {
              // 触发模块 hook
              const chunk = arguments[0][1];
              replaceIds.forEach(id => {
                if (pendingModules[id]) {
                  pendingModules[id](chunk, fbmodules);
                } else {
                  window.replaceIds = window.replaceIds.filter(x => x !== id);
                }
              });

              clearTimeout(refreshTimeout);
              refreshTimeout = setTimeout(() => {
                refreshModules();
              }, 1000);

              return registeredPushes[currentIdx].apply(webpackChunk_N_E, arguments);
            };
          }
          return originalPush;
        },
        set: val => {
          pushCount++;
          registeredPushes[pushCount] = val;
        }
      });

      // 注册初始 Hook
      const initialId = "hook-initial";
      pendingModules[initialId] = hookModuleFactory;
      window.replaceIds.push(initialId);
    }
  }

  // ----------------------------------------------------
  // 4. 执行初始化 Hook
  // ----------------------------------------------------
  setupFetchHook();
  setupWebpackHook();
  
  console.log("[FlowProxy] 代理拦截已就绪。");
})();
