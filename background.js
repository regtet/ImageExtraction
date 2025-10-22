// Service Worker - 后台脚本
// 处理扩展图标点击事件和网络请求拦截

// 存储已打开的应用页面标签ID
let appTabId = null;

// 存储网络请求拦截器状态
let networkInterceptorActive = false;
let interceptedImages = new Map(); // 存储拦截到的图片信息

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
        console.error('打开应用页面失败:', error);
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
    } else if (details.reason === 'update') {
        console.log('扩展已更新');
    }
});

// 网络请求拦截器
function startNetworkInterceptor() {
    if (networkInterceptorActive) return;

    networkInterceptorActive = true;

    // 监听所有网络请求
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            // 检查是否是图片请求
            if (isImageRequest(details.url)) {
                console.log('拦截到图片请求:', details.url);

                // 存储图片信息
                interceptedImages.set(details.url, {
                    url: details.url,
                    timestamp: Date.now(),
                    tabId: details.tabId,
                    type: 'network_request'
                });

                // 通知应用页面有新的图片
                notifyAppPage('newImage', {
                    url: details.url,
                    tabId: details.tabId
                });
            }
        },
        { urls: ["<all_urls>"] },
        ["requestBody"]
    );

    console.log('网络请求拦截器已启动');
}

// 停止网络请求拦截器
function stopNetworkInterceptor() {
    if (!networkInterceptorActive) return;

    networkInterceptorActive = false;
    chrome.webRequest.onBeforeRequest.removeListener(startNetworkInterceptor);

    console.log('网络请求拦截器已停止');
}

// 判断是否是图片请求
function isImageRequest(url) {
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)$/i;
    const imageMimeTypes = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;

    return imageExtensions.test(url) ||
           imageMimeTypes.test(url) ||
           url.includes('image/') ||
           url.includes('img/') ||
           url.includes('photo/') ||
           url.includes('picture/');
}

// 通知应用页面
function notifyAppPage(action, data) {
    if (appTabId) {
        chrome.tabs.sendMessage(appTabId, {
            action: action,
            data: data
        }).catch(error => {
            console.log('无法发送消息到应用页面:', error);
        });
    }
}

// 监听来自应用页面的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'startNetworkInterceptor':
            startNetworkInterceptor();
            sendResponse({ success: true });
            break;

        case 'stopNetworkInterceptor':
            stopNetworkInterceptor();
            sendResponse({ success: true });
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
