// Service Worker - 后台脚本
// 处理扩展图标点击事件

// 存储已打开的应用页面标签ID
let appTabId = null;

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
