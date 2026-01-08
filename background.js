// Service Worker - 后台脚本
// 处理扩展图标点击事件和网络请求拦截

// 存储已打开的应用页面标签ID
let appTabId = null;

// 存储网络请求拦截器状态
let networkInterceptorActive = false;
let interceptedImages = new Map(); // 存储拦截到的图片信息
let targetTabId = null; // 当前目标标签页ID（只拦截这个标签页的图片）
let targetTabUrl = null; // 当前目标标签页的URL（用于检测页面导航）

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
    try {
        // 检查应用页面是否已打开
        if (appTabId !== null) {
            try {
                // 尝试激活已存在的应用页面
                await chrome.tabs.get(appTabId);
                await chrome.tabs.update(appTabId, { active: true });
                return;
            } catch (error) {
                // 标签页不存在，清除ID
                appTabId = null;
            }
        }

        // 创建新的应用页面
        const newTab = await chrome.tabs.create({
            url: chrome.runtime.getURL('app.html'),
            active: true
        });

        appTabId = newTab.id;
    } catch (error) {
        console.error('[ImageCapture] 打开应用页面失败:', error);
    }
});

// 监听标签页关闭事件
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === appTabId) {
        appTabId = null;
    }
});

// 监听安装事件
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // 首次安装，打开欢迎页面
        chrome.tabs.create({
            url: chrome.runtime.getURL('app.html')
        });
    }
});

// 网络请求拦截器监听函数
let networkRequestListener = null;

// 网络请求拦截器
async function startNetworkInterceptor(tabId = null) {
    // 获取目标标签页的URL
    if (tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const newUrl = tab.url;
            // 如果URL变化了，清空拦截记录（页面导航了）
            if (targetTabUrl && targetTabUrl !== newUrl) {
                interceptedImages.clear();
            }
            targetTabUrl = newUrl;
        } catch (e) {
            // 忽略错误
        }
    }

    // 如果已经启动，更新目标标签页ID和URL
    if (networkInterceptorActive) {
        targetTabId = tabId;
        // 更新URL（如果提供了tabId）
        if (tabId) {
            try {
                const tab = await chrome.tabs.get(tabId);
                const newUrl = tab.url;
                // 如果URL变化了，清空拦截记录（页面导航了）
                if (targetTabUrl && targetTabUrl !== newUrl) {
                    interceptedImages.clear();
                }
                targetTabUrl = newUrl;
            } catch (e) {
                // 忽略错误
            }
        } else {
            targetTabUrl = null;
        }
        // 不打印更新日志，减少日志噪音
        return;
    }

    networkInterceptorActive = true;
    targetTabId = tabId; // 设置目标标签页ID

    // 创建监听函数
    networkRequestListener = async (details) => {
        const url = details.url;
        const requestTabId = details.tabId;

        // 检查是否是图片请求
        const isImage = isImageRequest(url);
        if (!isImage) {
            return; // 不是图片，直接返回
        }

        let tabId = requestTabId;

        // 移除tabId限制：拦截所有图片请求，由应用页面决定是否显示
        // 如果tabId是-1，尝试通过URL找到对应的标签页
        if (tabId === -1 && targetTabId !== null) {
            try {
                // 获取目标标签页信息
                const targetTab = await chrome.tabs.get(targetTabId);
                if (targetTab && targetTab.url) {
                    try {
                        const urlObj = new URL(details.url);
                        const tabUrlObj = new URL(targetTab.url);
                        // 如果域名匹配，认为是目标标签页的图片
                        if (tabUrlObj.hostname === urlObj.hostname) {
                            tabId = targetTabId;
                        }
                    } catch (e) {
                        // URL解析失败，使用原始tabId
                    }
                }
            } catch (e) {
                // 获取标签页失败，使用原始tabId
            }
        }

        // 检查是否已经拦截过这张图片（避免重复）
        if (interceptedImages.has(url)) {
            return; // 已经拦截过，不重复处理
        }

        // 存储图片信息
        interceptedImages.set(url, {
            url: url,
            timestamp: Date.now(),
            tabId: tabId,
            type: 'network_request'
        });

        // 通知应用页面有新的图片（实时添加）
        notifyAppPage('newImage', {
            url: url,
            tabId: tabId,
            type: 'network_request'
        });
    };

    // 监听所有网络请求
    chrome.webRequest.onBeforeRequest.addListener(
        networkRequestListener,
        { urls: ["<all_urls>"] },
        ["requestBody"]
    );

}

// 停止网络请求拦截器
function stopNetworkInterceptor() {
    if (!networkInterceptorActive) return;

    networkInterceptorActive = false;
    targetTabId = null; // 清除目标标签页ID
    targetTabUrl = null; // 清除目标标签页URL

    if (networkRequestListener) {
        chrome.webRequest.onBeforeRequest.removeListener(networkRequestListener);
        networkRequestListener = null;
    }

}

// 判断是否是图片请求（严格版）
function isImageRequest(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    const urlLower = url.toLowerCase();

    // 首先排除明显不是图片的文件类型（必须在URL末尾或查询参数前）
    const nonImageExtensions = /\.(css|js|html|htm|json|xml|txt|pdf|zip|rar|exe|dll|woff|woff2|ttf|eot|otf)(\?|#|$)/i;
    if (nonImageExtensions.test(url)) {
        return false;
    }

    // 排除包含这些关键词但不是图片的URL（更严格的检查）
    if (urlLower.includes('.css') || urlLower.includes('.js') ||
        urlLower.includes('/css/') || urlLower.includes('/js/') ||
        urlLower.includes('stylesheet') || urlLower.includes('script') ||
        urlLower.endsWith('.css') || urlLower.endsWith('.js')) {
        return false;
    }

    // 检查是否是data URL图片
    if (url.startsWith('data:image/')) {
        return true;
    }

    // 检查文件扩展名（必须明确是图片格式）
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;
    if (imageExtensions.test(url)) {
        return true;
    }

    // 检查URL中是否包含图片相关的路径（更宽松的匹配）
    // 但必须严格排除CSS/JS文件
    if (urlLower.includes('/image') || urlLower.includes('/img') ||
        urlLower.includes('/photo') || urlLower.includes('/pic') ||
        urlLower.includes('/media') || urlLower.includes('/upload')) {
        // 如果URL包含图片路径但没有扩展名，也认为是图片（可能是动态生成的）
        // 但必须严格排除CSS/JS
        if (!urlLower.includes('.css') && !urlLower.includes('.js') &&
            !urlLower.includes('stylesheet') && !urlLower.includes('script') &&
            !urlLower.endsWith('.css') && !urlLower.endsWith('.js') &&
            !/\.(css|js)(\?|#|$)/i.test(url)) {
            return true;
        }
    }

    // 检查是否是blob URL（可能是图片，但需要进一步验证）
    // 注意：blob URL 无法直接判断内容类型，所以这里暂时不拦截
    // 让其他方式（DOM提取）来处理blob URL

    // 检查URL路径中的图片关键词（更严格的匹配）
    // 只有在路径中明确包含图片相关目录时才认为是图片
    const imagePathPatterns = [
        /\/images?\/[^\/]*$/i,           // /image/xxx 或 /images/xxx
        /\/photos?\/[^\/]*$/i,            // /photo/xxx 或 /photos/xxx
        /\/pics?\/[^\/]*$/i,             // /pic/xxx 或 /pics/xxx
        /\/gallery\/[^\/]*$/i,           // /gallery/xxx
        /\/media\/[^\/]*$/i,              // /media/xxx
        /\/assets\/.*\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)/i, // /assets/xxx.jpg
        /\/uploads?\/.*\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)/i, // /upload/xxx.jpg
    ];

    for (const pattern of imagePathPatterns) {
        if (pattern.test(url)) {
            // 再次确认不是CSS/JS文件（更严格的检查）
            if (!urlLower.includes('.css') && !urlLower.includes('.js') &&
                !urlLower.endsWith('.css') && !urlLower.endsWith('.js') &&
                !/\.(css|js)(\?|#|$)/i.test(url)) {
                return true;
            }
        }
    }

    return false;
}

// 通知应用页面
function notifyAppPage(action, data) {
    if (appTabId) {
        chrome.tabs.sendMessage(appTabId, {
            action: action,
            data: data
        }).catch(error => {
            // 静默失败，应用页面可能未打开
        });
    }
}

// 监听来自应用页面的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'startNetworkInterceptor':
            const tabId = request.tabId || null;
            const clearPrevious = request.clearPrevious !== false; // 默认清空之前的记录
            if (clearPrevious) {
                interceptedImages.clear(); // 清空之前的拦截记录，只显示新拦截的图片
            }
            // 异步执行，但不阻塞响应
            startNetworkInterceptor(tabId).catch(() => { });
            sendResponse({ success: true });
            break;

        case 'stopNetworkInterceptor':
            stopNetworkInterceptor();
            sendResponse({ success: true });
            break;

        case 'imageDetected':
            // 处理从content script检测到的图片
            interceptedImages.set(request.data.url, {
                url: request.data.url,
                timestamp: Date.now(),
                tabId: sender.tab?.id,
                type: request.data.type || 'performance_observer',
                size: request.data.size || 0,
                duration: request.data.duration || 0
            });

            // 通知应用页面有新的图片
            notifyAppPage('newImage', {
                url: request.data.url,
                tabId: sender.tab?.id,
                type: request.data.type
            });
            break;

        case 'getInterceptedImages':
            sendResponse({
                success: true,
                images: Array.from(interceptedImages.values())
            });
            break;

        case 'clearInterceptedImages':
            interceptedImages.clear();
            sendResponse({ success: true });
            break;

        default:
            sendResponse({ success: false, error: 'Unknown action' });
    }

    return true; // 保持消息通道开放
});
