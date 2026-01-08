// 内容脚本 - 在网页上下文中运行
// 监听网络请求和Performance API

// Content script 已加载

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
}

// 停止Performance Observer
function stopPerformanceObserver() {
    if (performanceObserver) {
        performanceObserver.disconnect();
        performanceObserver = null;
    }
}

// 判断是否是图片资源（严格版）
function isImageResource(url) {
    if (!url || typeof url !== 'string') return false;

    const urlLower = url.toLowerCase();

    // 首先排除明显不是图片的文件类型
    const nonImageExtensions = /\.(css|js|html|htm|json|xml|txt|pdf|zip|rar|exe|dll|woff|woff2|ttf|eot|otf)(\?.*)?$/i;
    if (nonImageExtensions.test(url)) {
        return false;
    }

    // 排除包含这些关键词但不是图片的URL
    if (urlLower.includes('.css') || urlLower.includes('.js') ||
        urlLower.includes('/css/') || urlLower.includes('/js/') ||
        urlLower.includes('stylesheet') || urlLower.includes('script')) {
        return false;
    }

    // 检查是否是data URL图片
    if (url.startsWith('data:image/')) return true;

    // 检查文件扩展名（必须明确是图片格式）
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;
    if (imageExtensions.test(url)) {
        return true;
    }

    // 检查是否是blob URL（可能是图片，但需要进一步验证）
    // 注意：blob URL 无法直接判断内容类型，所以这里暂时不拦截
    // 让其他方式（DOM提取）来处理blob URL

    // 检查URL路径中的图片关键词（更严格的匹配）
    // 只有在路径中明确包含图片相关目录时才认为是图片
    const imagePathPatterns = [
        /\/images?\/[^\/]*$/i,           // /image/xxx 或 /images/xxx
        /\/photos?\/[^\/]*$/i,           // /photo/xxx 或 /photos/xxx
        /\/pics?\/[^\/]*$/i,             // /pic/xxx 或 /pics/xxx
        /\/gallery\/[^\/]*$/i,           // /gallery/xxx
        /\/media\/[^\/]*$/i,             // /media/xxx
        /\/assets\/.*\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)/i, // /assets/xxx.jpg
        /\/uploads?\/.*\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)/i, // /upload/xxx.jpg
    ];

    for (const pattern of imagePathPatterns) {
        if (pattern.test(url)) {
            // 再次确认不是CSS/JS文件
            if (!urlLower.includes('.css') && !urlLower.includes('.js')) {
                return true;
            }
        }
    }

    return false;
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
            const initiatorType = entry.initiatorType || 'unknown';

            // 首先排除明显不是图片的资源
            if (url.includes('.css') || url.includes('.js') ||
                url.includes('/css/') || url.includes('/js/')) {
                return; // 跳过CSS和JS文件
            }

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
            } else if ((initiatorType === 'img' || initiatorType === 'image') && !seenUrls.has(url)) {
                // 即使检测函数没匹配到，如果initiatorType是img，也认为是图片
                // 但需要再次确认不是CSS/JS文件
                if (!url.includes('.css') && !url.includes('.js')) {
                    seenUrls.add(url);
                    images.push({
                        url: url,
                        type: 'network_request',
                        width: 0,
                        height: 0,
                        alt: ''
                    });
                }
            }
        });
    } catch (error) {
        // 静默失败
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
