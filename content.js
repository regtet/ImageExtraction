// 内容脚本 - 在网页上下文中运行
// 监听网络请求和Performance API

console.log('图片提取大师 - 内容脚本已加载');

// 存储拦截到的图片
let interceptedImages = new Set();
let performanceObserver = null;

// 启动Performance Observer监听资源加载
function startPerformanceObserver() {
    if (performanceObserver) return;

    performanceObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
            // 检查是否是图片资源
            if (isImageResource(entry.name)) {
                console.log('Performance Observer捕获图片:', entry.name);

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
                });
            }
        });
    });

    // 监听资源加载
    performanceObserver.observe({ entryTypes: ['resource'] });
    console.log('Performance Observer已启动');
}

// 停止Performance Observer
function stopPerformanceObserver() {
    if (performanceObserver) {
        performanceObserver.disconnect();
        performanceObserver = null;
        console.log('Performance Observer已停止');
    }
}

// 判断是否是图片资源
function isImageResource(url) {
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)$/i;
    const imageMimeTypes = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;

    return imageExtensions.test(url) ||
           imageMimeTypes.test(url) ||
           url.includes('image/') ||
           url.includes('img/') ||
           url.includes('photo/') ||
           url.includes('picture/') ||
           url.includes('avatar/') ||
           url.includes('thumbnail/');
}

// 拦截fetch请求
function interceptFetch() {
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = args[0];
        if (typeof url === 'string' && isImageResource(url)) {
            console.log('Fetch拦截图片请求:', url);
            interceptedImages.add(url);

            chrome.runtime.sendMessage({
                action: 'imageDetected',
                data: {
                    url: url,
                    type: 'fetch_intercept'
                }
            });
        }
        return originalFetch.apply(this, args);
    };
}

// 拦截XMLHttpRequest
function interceptXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (typeof url === 'string' && isImageResource(url)) {
            console.log('XHR拦截图片请求:', url);
            interceptedImages.add(url);

            chrome.runtime.sendMessage({
                action: 'imageDetected',
                data: {
                    url: url,
                    type: 'xhr_intercept'
                }
            });
        }
        return originalOpen.call(this, method, url, ...args);
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

        default:
            sendResponse({ success: false, error: 'Unknown action' });
    }
    return true;
});

// 页面加载完成后自动启动监听
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        startPerformanceObserver();
        interceptFetch();
        interceptXHR();
    });
} else {
    startPerformanceObserver();
    interceptFetch();
    interceptXHR();
}
