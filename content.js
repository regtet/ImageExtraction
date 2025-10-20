// 内容脚本 - 在网页上下文中运行
// 这个文件主要用于在页面加载时准备环境
// 实际的图片提取逻辑在 popup.js 中通过 chrome.scripting.executeScript 执行

console.log('图片提取大师 - 内容脚本已加载');

// 可以在这里添加一些页面级别的功能
// 例如：监听快捷键、添加右键菜单等

// 监听来自 popup 的消息（如果需要）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        sendResponse({ status: 'ready' });
    }
    return true;
});
