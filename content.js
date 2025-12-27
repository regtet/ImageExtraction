// 内容脚本 - 在网页上下文中运行
// 监听网络请求和Performance API

console.log('[ImageCapture] Content script 已加载');

// 存储拦截到的图片
let interceptedImages = new Set();
let performanceObserver = null;
let httpRequestMonitoringEnabled = false; // 控制HTTP请求监听是否启用

// 启动Performance Observer监听资源加载
function startPerformanceObserver() {
    if (performanceObserver) return;

    performanceObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
            // 检查是否是图片资源
            if (isImageResource(entry.name)) {
                // 添加到拦截列表
                interceptedImages.add(entry.name);

                // 通知background script
                chrome.runtime.sendMessage({
                    action: 'imageDetected',
                    data: {
                        url: entry.name,
                        size: entry.transferSize || 0,
                        duration: entry.duration || 0,
                        type: 'performance_observer'
                    }
                }).catch(err => {
                    // 静默失败，避免大量错误日志
                });
            }
        });
    });

    // 监听资源加载
    performanceObserver.observe({ entryTypes: ['resource'] });
    console.log('[ImageCapture] Performance Observer 已启动');
}

// 停止Performance Observer
function stopPerformanceObserver() {
    if (performanceObserver) {
        performanceObserver.disconnect();
        performanceObserver = null;
        console.log('[ImageCapture] Performance Observer 已停止');
    }
}

// 判断是否是图片资源
function isImageResource(url) {
    if (!url || typeof url !== 'string') return false;

    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)$/i;
    const imageMimeTypes = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;

    return imageExtensions.test(url) ||
           imageMimeTypes.test(url) ||
           url.includes('image/') ||
           url.includes('img/') ||
           url.includes('photo/') ||
           url.includes('picture/') ||
           url.includes('avatar/') ||
           url.includes('thumbnail/') ||
           url.match(/\/images?\//i) !== null ||
           url.match(/\/pics?\//i) !== null;
}

// 获取页面已加载的所有图片资源（使用 Performance API）
function getAllLoadedImageResources() {
    const images = [];
    const seenUrls = new Set();

    try {
        // 使用 Performance API 获取所有已加载的资源
        const resources = performance.getEntriesByType('resource');

        resources.forEach(entry => {
            const url = entry.name;

            // 检查是否是图片资源
            if (isImageResource(url) && !seenUrls.has(url)) {
                seenUrls.add(url);

                images.push({
                    url: url,
                    type: 'network_request',
                    width: 0,
                    height: 0,
                    alt: ''
                });
            }
        });
    } catch (error) {
        console.error(`[ImageCapture] 获取已加载图片资源失败:`, error);
    }

    return images;
}

// 拦截fetch请求 - 监听所有HTTP请求（不只是图片）
let originalFetch = null;
function interceptFetch() {
    if (originalFetch) return; // 已经拦截过了
    originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = args[0];
        if (httpRequestMonitoringEnabled && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
            // 通知有新的HTTP请求，触发图片提取
            chrome.runtime.sendMessage({
                action: 'httpRequestDetected',
                data: {
                    url: url,
                    type: 'fetch'
                }
            }).catch(err => {
                // 静默失败
            });
        }
        return originalFetch.apply(this, args);
    };
}

// 拦截XMLHttpRequest - 监听所有HTTP请求
let originalXHROpen = null;
function interceptXHR() {
    if (originalXHROpen) return; // 已经拦截过了
    originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (httpRequestMonitoringEnabled && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
            // 通知有新的HTTP请求，触发图片提取
            chrome.runtime.sendMessage({
                action: 'httpRequestDetected',
                data: {
                    url: url,
                    type: 'xhr'
                }
            }).catch(err => {
                // 静默失败
            });
        }
        return originalXHROpen.call(this, method, url, ...args);
    };
}

// 监听来自background script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'ping':
            sendResponse({ status: 'ready' });
            break;

        case 'startNetworkMonitoring':
            startPerformanceObserver();
            interceptFetch();
            interceptXHR();
            sendResponse({ success: true });
            break;

        case 'stopNetworkMonitoring':
            stopPerformanceObserver();
            sendResponse({ success: true });
            break;

        case 'startHttpRequestMonitoring':
            httpRequestMonitoringEnabled = true;
            interceptFetch();
            interceptXHR();
            sendResponse({ success: true });
            break;

        case 'stopHttpRequestMonitoring':
            httpRequestMonitoringEnabled = false;
            sendResponse({ success: true });
            break;

        case 'getInterceptedImages':
            sendResponse({
                success: true,
                images: Array.from(interceptedImages)
            });
            break;

        case 'clearInterceptedImages':
            interceptedImages.clear();
            sendResponse({ success: true });
            break;

        case 'getAllLoadedImages':
            // 获取页面已加载的所有图片资源
            const images = getAllLoadedImageResources();
            sendResponse({
                success: true,
                images: images
            });
            break;

        default:
            sendResponse({ success: false, error: 'Unknown action' });
    }
    return true;
});

// 页面加载完成后不自动启动监听，等待app.js的指令
