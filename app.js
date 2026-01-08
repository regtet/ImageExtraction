let allImages = [];
let filteredImages = [];
let selectedImages = new Set();
let currentTabId = null;
let autoExtractEnabled = false;
// let lastImageCount = 0; // 未使用的变量，已移除
let lastClickedIndex = -1; // 用于Shift范围选择
let activeSizeFilters = new Set(); // 当前激活的尺寸筛选（支持多选）
let sizeFilterUserCleared = false; // 用户是否主动清空尺寸筛选（避免自动回填）
let sizeFilterUserModified = false; // 用户是否手动改过尺寸筛选（避免自动回填覆盖）
let lastSizeSet = new Set(); // 上一次尺寸集合，用于检测是否全选过

// 汇总打印相关
let firstWaveImages = []; // 第一波图片（初始加载）
let secondWaveImages = []; // 第二波图片（新请求）
let summaryTimer = null; // 汇总打印定时器
let isFirstWave = true; // 是否还在第一波
let pageLoadStartTime = null; // 页面加载开始时间

// 网络请求监听相关
let networkMonitoringEnabled = false;
let interceptedImages = new Set(); // 存储拦截到的图片URL
let processingImages = new Set(); // 正在处理的图片URL，防止重复处理（使用去重Key）

// 黑名单相关
let blacklistKeywords = new Set(); // 存储黑名单关键字

// 白名单相关
let whitelistKeywords = new Set(); // 存储白名单关键字
let filterMode = 'blacklist'; // 过滤模式：'blacklist' 或 'whitelist'
let captureMode = 'dom'; // 捕获模式：'performance', 'webrequest', 'dom'

// DOM元素
const tabSelect = document.getElementById('tabSelect');
const refreshTabsBtn = document.getElementById('refreshTabsBtn');
const captureModeSelect = document.getElementById('captureModeSelect');
const captureModeDescription = document.getElementById('captureModeDescription');
const sortSelect = document.getElementById('sortSelect');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');
const invertSelectionBtn = document.getElementById('invertSelectionBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const clearBtn = document.getElementById('clearBtn');
const imageGrid = document.getElementById('imageGrid');
const emptyState = document.getElementById('emptyState');
const loadingIndicator = document.getElementById('loadingIndicator');
const imageCountSpan = document.getElementById('imageCount');
const selectedCountSpan = document.getElementById('selectedCount');
const sizeTagsContainer = document.getElementById('sizeTagsContainer');
const sizeTags = document.getElementById('sizeTags');
const clearSizeFilterBtn = document.getElementById('clearSizeFilterBtn');
const selectAllSizesBtn = document.getElementById('selectAllSizesBtn');
const deselectAllSizesBtn = document.getElementById('deselectAllSizesBtn');

// 黑名单相关DOM元素
const blacklistInput = document.getElementById('blacklistInput');
const addBlacklistBtn = document.getElementById('addBlacklistBtn');
const blacklistTags = document.getElementById('blacklistTags');

// 白名单相关DOM元素（已隐藏）
const whitelistInput = document.getElementById('whitelistInput');
const addWhitelistBtn = document.getElementById('addWhitelistBtn');
const whitelistTags = document.getElementById('whitelistTags');
const whitelistRow = document.querySelector('.whitelist-row');
const blacklistRow = document.querySelector('.blacklist-row');

// 初始化
async function init() {
    loadSizeFilterState(); // 加载保存的尺寸筛选状态
    loadCaptureModeState(); // 加载保存的捕获模式

    setupEventListeners();
    setupTabUpdateWatcher(); // 监听标签页导航完成后自动重新提取
    setupNetworkMonitoring(); // 监听网络请求和拦截图片消息

    // 默认开启HTTP请求监听（当有新HTTP请求时提取图片）
    autoExtractEnabled = true;

    // 加载标签页
    await loadAvailableTabs();
}

// 设置事件监听
function setupEventListeners() {
    tabSelect.addEventListener('change', handleTabChange);
    refreshTabsBtn.addEventListener('click', loadAvailableTabs);
    captureModeSelect.addEventListener('change', handleCaptureModeChange);
    // 使用防抖处理排序和筛选，避免频繁刷新导致UI抖动
    sortSelect.addEventListener('change', () => {
        if (applyFiltersAndSortTimer) clearTimeout(applyFiltersAndSortTimer);
        applyFiltersAndSortTimer = setTimeout(() => {
            applyFiltersAndSort();
        }, 100);
    });
    clearSizeFilterBtn.addEventListener('click', clearSizeFilter);
    selectAllSizesBtn.addEventListener('click', selectAllSizes);
    deselectAllSizesBtn.addEventListener('click', deselectAllSizes);
    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);
    invertSelectionBtn.addEventListener('click', invertSelection);
    downloadSelectedBtn.addEventListener('click', downloadSelected);
    clearBtn.addEventListener('click', clearAll);
    // 黑白名单已移除，无需事件绑定

}

// 启用HTTP请求监听（替代定时器自动提取）
function enableAutoExtract() {
    const selectedTabId = parseInt(tabSelect.value);
    if (!selectedTabId) {
        return;
    }

    // 先提取一次
    extractImagesFromCurrentTab();

    // 根据捕获模式决定是否启动background拦截
    if (captureMode === 'performance' || captureMode === 'webrequest') {
        // Performance和WebRequest模式：启动background拦截，传递目标标签页ID
        // 首次启动时清空之前的记录
        chrome.runtime.sendMessage({
            action: 'startNetworkInterceptor',
            tabId: selectedTabId,
            clearPrevious: true // 清空之前的拦截记录
        }).catch(() => { });
        // Performance模式也需要启动content script的Performance Observer
        if (captureMode === 'performance') {
            chrome.tabs.sendMessage(selectedTabId, { action: 'startNetworkMonitoring' }).catch(() => { });
        }
    }
}

// 启动HTTP请求监听
async function startHttpRequestMonitoring(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'startHttpRequestMonitoring' });
    } catch (error) {
        // 如果content script还未加载，尝试注入
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            await chrome.tabs.sendMessage(tabId, { action: 'startHttpRequestMonitoring' });
        } catch (err) {
        }
    }
}

// 停止HTTP请求监听
async function stopHttpRequestMonitoring(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'stopHttpRequestMonitoring' });
    } catch (error) {
        // 忽略错误
    }
}

// 处理HTTP请求检测，触发图片提取（带防抖）
let extractDebounceTimer = null;
async function handleHttpRequestDetected(tabId) {
    // 防抖：如果当前标签页匹配，延迟500ms后提取（避免频繁提取）
    if (parseInt(tabSelect.value) === tabId) {
        if (extractDebounceTimer) {
            clearTimeout(extractDebounceTimer);
        }
        extractDebounceTimer = setTimeout(async () => {
            await extractImagesFromCurrentTab();
        }, 500);
    }
}

// 加载可用标签页
async function loadAvailableTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        tabSelect.innerHTML = '';

        // 过滤掉chrome://等特殊页面，包括扩展页面
        const validTabs = tabs.filter(tab =>
            !tab.url.startsWith('chrome://') &&
            !tab.url.startsWith('chrome-extension://') &&
            !tab.url.startsWith('edge://') &&
            !tab.url.startsWith('about:') &&
            !tab.url.includes('extension') // 排除扩展页面
        );

        if (validTabs.length === 0) {
            tabSelect.innerHTML = '<option value="">没有可提取的页面</option>';
            return;
        }

        // 按最后访问时间排序，最新的在前面
        validTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

        // 尝试找到当前活跃的标签页（排除扩展页面）
        let selectedTab = null;
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            // 检查活跃标签页是否在有效标签页列表中
            if (activeTab && validTabs.some(tab => tab.id === activeTab.id)) {
                selectedTab = activeTab;
            }
        } catch (error) {
            // 忽略错误
        }

        // 如果没有找到活跃标签页，选择最新的标签页
        if (!selectedTab && validTabs.length > 0) {
            selectedTab = validTabs[0];
        }

        // 创建选项
        validTabs.forEach((tab, index) => {
            const option = document.createElement('option');
            option.value = tab.id;
            option.textContent = tab.title || tab.url;

            // 选择目标标签页
            if (selectedTab && tab.id === selectedTab.id) {
                option.selected = true;
                currentTabId = tab.id;
            }
            tabSelect.appendChild(option);
        });

        // 如果找到了合适的标签页，自动提取该页面的图片
        if (selectedTab) {
            // 延迟一点时间确保UI完全加载
            setTimeout(async () => {
                await extractImagesFromCurrentTab();
                // 启动自动持续提取
                enableAutoExtract();
            }, 1000);
        }
    } catch (error) {
    }
}

// 处理捕获模式切换
async function handleCaptureModeChange() {
    const newMode = captureModeSelect.value;
    const oldMode = captureMode;
    captureMode = newMode;
    saveCaptureModeState();
    updateCaptureModeDescription(); // 更新模式描述

    showNotification(`已切换到${getCaptureModeName(newMode)}模式`, 'info');

    // 切换模式时，清空共享的存储，确保模式之间相互隔离
    // 1. 清空background script中的拦截图片
    try {
        await chrome.runtime.sendMessage({ action: 'clearInterceptedImages' });
    } catch (error) {
    }

    // 2. 清空当前图片列表，避免显示其他模式的数据
    allImages = [];
    filteredImages = [];
    selectedImages.clear();
    renderImages(0);
    updateStats();

    // 如果是WebRequest模式，重置汇总数据
    if (newMode === 'webrequest') {
        resetSummary();
    }

    // 3. 停止旧的监听器
    const selectedTabId = parseInt(tabSelect.value);
    if (selectedTabId) {
        // 停止旧的网络拦截器（Performance和WebRequest模式使用）
        await chrome.runtime.sendMessage({ action: 'stopNetworkInterceptor' }).catch(() => { });
    }

    // 4. 如果当前有选中的标签页，使用新模式重新提取并重新启动监听
    if (selectedTabId) {
        await extractImagesFromCurrentTab();
        // 重新启动监听（使用新的目标标签页ID）
        enableAutoExtract();
    }
}

// 获取捕获模式名称
function getCaptureModeName(mode) {
    const names = {
        'performance': 'Performance API',
        'webrequest': 'WebRequest'
    };
    return names[mode] || mode;
}

// 获取捕获模式描述
function getCaptureModeDescription(mode) {
    const descriptions = {
        'performance': '从 Performance API 获取所有已成功加载的图片资源（快速，包含历史图片）',
        'webrequest': '使用 WebRequest API 拦截所有图片网络请求（实时拦截，仅捕获HTTP请求的图片）'
    };
    return descriptions[mode] || '';
}

// 更新模式描述显示
function updateCaptureModeDescription() {
    if (captureModeDescription) {
        const description = getCaptureModeDescription(captureMode);
        captureModeDescription.textContent = description || '';
    }
}

// 保存捕获模式状态
function saveCaptureModeState() {
    localStorage.setItem('imageExtractor_captureMode', captureMode);
}

// 加载捕获模式状态
function loadCaptureModeState() {
    try {
        const saved = localStorage.getItem('imageExtractor_captureMode');
        if (saved && ['performance', 'webrequest'].includes(saved)) {
            captureMode = saved;
            captureModeSelect.value = saved;
        }
        // 无论是否有保存的状态，都更新模式描述
        updateCaptureModeDescription();
    } catch (error) {
        updateCaptureModeDescription();
    }
}

// 切换目标标签页
async function handleTabChange() {
    const newTabId = parseInt(tabSelect.value) || null;

    // 停止现有监听
    const oldTabId = currentTabId;

    // 清空旧数据，防止跨标签残留
    allImages = [];
    currentTabId = newTabId;

    if (!currentTabId) {
        return;
    }

    // 获取新标签页的URL
    let newTabUrl = null;
    try {
        const newTab = await chrome.tabs.get(currentTabId);
        if (newTab && newTab.url) {
            newTabUrl = newTab.url;
        }
    } catch (e) {
        // 忽略错误
    }

    // 检查是否是域名变化（跨站点），而不是同一站内路径变化
    // 只在域名变化时才清空数据
    let newHost = null;
    try {
        if (newTabUrl) {
            newHost = new URL(newTabUrl).hostname;
        }
    } catch (e) {
        // 忽略解析错误，视为无效URL
    }

    if (newHost && newHost !== lastTabUrl) {
        // 域名变化了，说明是切换到不同站点，清空所有数据
        lastTabUrl = newHost;
        allImages = [];
        filteredImages = [];
        selectedImages.clear();
        lastClickedIndex = -1;

        // 重置尺寸筛选状态（已隐藏）
        activeSizeFilters.clear();
        sizeFilterUserCleared = false; // 新标签默认可自动全选
        sizeFilterUserModified = false;
        saveSizeFilterState();
        sizeTagsContainer.style.display = 'none';
        clearSizeFilterBtn.style.display = 'none';

        // 清空界面
        renderImages(0);
        updateStats();

        // 如果是WebRequest模式，清空拦截记录和重置汇总数据
        if (captureMode === 'webrequest') {
            await chrome.runtime.sendMessage({ action: 'clearInterceptedImages' }).catch(() => { });
            resetSummary(); // 重置汇总数据
        }
    } else {
        // URL没变化，说明是同一个页面的不同tab，不清空数据，只更新lastTabUrl
        if (newTabUrl) {
            lastTabUrl = newTabUrl;
        }
        // 确保界面显示当前数据
        applyFiltersAndSort();
    }

    // 重新提取并启动监听
    await extractImagesFromCurrentTab();

    // 启动新标签页的监听
    enableAutoExtract();
}

// 模式1: 使用Performance API提取图片
async function extractImagesUsingPerformanceAPI(tabId) {
    try {
        // 从content script获取Performance API中的图片资源
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getAllLoadedImages' });
        if (response && response.success && response.images) {
            return response.images.map(img => ({
                ...img,
                tabId: tabId,
                type: img.type || 'network_request'
            }));
        }
    } catch (error) {
        // 如果content script未加载，尝试注入
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // 增加等待时间
            const response = await chrome.tabs.sendMessage(tabId, { action: 'getAllLoadedImages' });
            if (response && response.success && response.images) {
                return response.images.map(img => ({
                    ...img,
                    tabId: tabId,
                    type: img.type || 'network_request'
                }));
            }
        } catch (err) {
        }
    }
    return [];
}

// 模式2: 使用WebRequest提取图片（纯实时模式，不提取历史数据）
async function extractImagesUsingWebRequest(tabId) {
    // WebRequest模式是纯实时拦截模式，不主动提取历史数据
    // 图片会通过拦截器实时添加到列表中
    // 这里返回空数组，表示不提取历史数据
    return [];
}

// 从当前选中的标签页提取图片（根据选择的模式）
async function extractImagesFromCurrentTab() {
    const selectedTabId = parseInt(tabSelect.value);

    if (!selectedTabId) {
        alert('请选择要提取图片的页面');
        return;
    }

    try {
        loadingIndicator.style.display = 'flex';
        emptyState.style.display = 'none';

        currentTabId = selectedTabId;

        // 保存当前选中的图片标识（基于URL+tabId，更可靠）
        const selectedKeys = new Set();
        selectedImages.forEach(index => {
            if (filteredImages[index]) {
                const img = filteredImages[index];
                // 使用URL+tabId作为唯一标识，避免相同URL在不同位置的混淆
                const key = getDedupKeyFromUrl(img.url, img.tabId);
                selectedKeys.add(key);
            }
        });

        // 根据选择的捕获模式提取图片
        let newImages = [];

        if (captureMode === 'performance') {
            // 模式1: Performance API
            newImages = await extractImagesUsingPerformanceAPI(selectedTabId);
        } else if (captureMode === 'webrequest') {
            // 模式2: WebRequest（纯实时拦截模式）
            // 不主动提取历史数据，只通过拦截器实时添加新请求的图片
            // 页面刷新时，图片列表已在loading阶段清空，这里不需要提取
            newImages = [];
        }

        // 统一打印提取结果

        // 等待图片加载完成后获取尺寸信息
        await loadImageDimensions(newImages);

        // 添加到现有图片列表（不重复，使用URL+tabId作为唯一标识）
        const existingKeys = new Set(allImages.map(img => getDedupKeyFromUrl(img.url, img.tabId)));
        let addedCount = 0;
        newImages.forEach(img => {
            const key = getDedupKeyFromUrl(img.url, img.tabId);
            if (!existingKeys.has(key)) {
                allImages.push(img);
                existingKeys.add(key);
                addedCount++;
            }
        });


        // 如果添加了新图片，立即进行去重检查（防止并发添加导致的重复）
        if (addedCount > 0) {
            removeDuplicateImages();
        }

        // 应用筛选和排序
        applyFiltersAndSort();

        // 恢复之前选中的图片（使用URL+tabId匹配，更准确）
        selectedImages.clear();
        filteredImages.forEach((img, index) => {
            const key = getDedupKeyFromUrl(img.url, img.tabId);
            if (selectedKeys.has(key)) {
                selectedImages.add(index);
            }
        });

        // 更新UI显示选中状态
        document.querySelectorAll('.image-item').forEach((item, index) => {
            if (selectedImages.has(index)) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });

        loadingIndicator.style.display = 'none';

        if (allImages.length === 0) {
            emptyState.innerHTML = `
        <div class="empty-icon">😕</div>
        <h2>未找到任何图片</h2>
        <p>该页面可能没有图片，或图片正在加载中</p>
      `;
            emptyState.style.display = 'flex';
        } else {
            // 显示提取成功提示
            showNotification(`成功提取 ${newImages.length} 张图片！总共 ${allImages.length} 张`, 'success');
        }
    } catch (error) {
        loadingIndicator.style.display = 'none';
        showNotification('提取失败，请确保页面已完全加载', 'error');
    }
}

// 在页面中执行的函数（提取图片）- 已废弃，改为使用网络请求捕获
// DOM提取模式已移除，此函数不再使用
function extractImagesFromPage_DEPRECATED() {
    const images = [];
    const seenUrls = new Set();

    // 辅助函数：添加图片到列表
    function addImage(url, type, width = 0, height = 0, alt = '') {
        if (!url || seenUrls.has(url)) return;

        // 处理相对URL
        if (!url.startsWith('http') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('//')) {
            try {
                url = new URL(url, window.location.href).href;
            } catch (e) {
                // 忽略URL解析错误
                return;
            }
        }

        // 处理协议相对URL (//example.com/image.jpg)
        if (url.startsWith('//')) {
            url = window.location.protocol + url;
        }

        // 跳过无效URL
        if (url === 'null' || url === 'undefined' || url.trim() === '' || url === 'about:blank') return;

        seenUrls.add(url);
        images.push({
            url: url,
            type: type,
            width: width,
            height: height,
            alt: alt
        });
    }

    // 1. 提取 <img> 标签（包括懒加载属性）
    const imgElements = document.querySelectorAll('img');

    imgElements.forEach(img => {
        // 尝试多个可能的src属性（支持懒加载）
        const possibleSrcs = [
            img.currentSrc,
            img.src,
            img.getAttribute('src'),
            img.getAttribute('data-src'),
            img.getAttribute('data-lazy-src'),
            img.getAttribute('data-original'),
            img.getAttribute('data-srcset'),
            img.getAttribute('data-lazy'),
            img.getAttribute('lazy-src'),
            img.getAttribute('data-url')
        ].filter(Boolean);

        possibleSrcs.forEach(src => {
            if (!src) return;

            // 处理 srcset（可能包含多个URL）
            if (src.includes(',')) {
                // 解析 srcset 格式: "url1 1x, url2 2x" 或 "url1 100w, url2 200w"
                const srcsetUrls = src.split(',').map(s => s.trim().split(/\s+/)[0]);
                srcsetUrls.forEach(url => {
                    if (url) {
                        let width = img.naturalWidth || img.width || 0;
                        let height = img.naturalHeight || img.height || 0;
                        if (width === 0 && height === 0) {
                            width = parseInt(img.getAttribute('width')) || 0;
                            height = parseInt(img.getAttribute('height')) || 0;
                        }
                        addImage(url, url.startsWith('data:') ? 'base64' : 'img', width, height, img.alt || '');
                    }
                });
            } else {
                let width = img.naturalWidth || img.width || 0;
                let height = img.naturalHeight || img.height || 0;
                if (width === 0 && height === 0) {
                    width = parseInt(img.getAttribute('width')) || 0;
                    height = parseInt(img.getAttribute('height')) || 0;
                }
                addImage(src, src.startsWith('data:') ? 'base64' : 'img', width, height, img.alt || '');
            }
        });

        // 处理 srcset 属性
        if (img.srcset) {
            const srcsetUrls = img.srcset.split(',').map(s => s.trim().split(/\s+/)[0]);
            srcsetUrls.forEach(url => {
                if (url) {
                    let width = img.naturalWidth || img.width || 0;
                    let height = img.naturalHeight || img.height || 0;
                    if (width === 0 && height === 0) {
                        width = parseInt(img.getAttribute('width')) || 0;
                        height = parseInt(img.getAttribute('height')) || 0;
                    }
                    addImage(url, 'img', width, height, img.alt || '');
                }
            });
        }
    });

    // 2. 提取 <picture> 标签中的 <source> 元素
    document.querySelectorAll('picture source').forEach(source => {
        const srcset = source.getAttribute('srcset');
        if (srcset) {
            const srcsetUrls = srcset.split(',').map(s => s.trim().split(/\s+/)[0]);
            srcsetUrls.forEach(url => {
                if (url) {
                    addImage(url, 'img', 0, 0, '');
                }
            });
        }
        const src = source.getAttribute('src');
        if (src) {
            addImage(src, 'img', 0, 0, '');
        }
    });

    // 3. 提取背景图片
    const allElements = document.querySelectorAll('*');

    allElements.forEach(element => {
        try {
            const style = window.getComputedStyle(element);
            const bgImage = style.backgroundImage;

            if (bgImage && bgImage !== 'none') {
                const matches = bgImage.match(/url\(["']?([^"']*)["']?\)/g);
                if (matches) {
                    matches.forEach(match => {
                        let url = match.replace(/url\(["']?/, '').replace(/["']?\)/, '');
                        if (url) {
                            addImage(url, url.startsWith('data:') ? 'base64' : 'background', 0, 0, '');
                        }
                    });
                }
            }
        } catch (e) {
            // 忽略样式计算错误
        }
    });

    // 4. 提取 SVG 图片
    document.querySelectorAll('svg').forEach(svg => {
        try {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svg);
            const base64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));

            let width = svg.width?.baseVal?.value || svg.getAttribute('width') || 0;
            let height = svg.height?.baseVal?.value || svg.getAttribute('height') || 0;

            // 尝试从 viewBox 获取尺寸
            if ((width === 0 || height === 0) && svg.viewBox?.baseVal) {
                width = svg.viewBox.baseVal.width || 0;
                height = svg.viewBox.baseVal.height || 0;
            }

            addImage(base64, 'base64', width, height, 'SVG图片');
        } catch (e) {
        }
    });

    // 5. 从 Performance API 获取已加载的图片资源（补充遗漏的）
    try {
        const resources = performance.getEntriesByType('resource');

        resources.forEach(entry => {
            const url = entry.name;
            const initiatorType = entry.initiatorType || 'unknown';

            // 首先排除明显不是图片的资源
            if (!url || url.includes('.css') || url.includes('.js') ||
                url.includes('/css/') || url.includes('/js/')) {
                return; // 跳过CSS和JS文件
            }

            // 检查是否是图片资源（必须明确是图片格式）
            const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?.*)?$/i;
            if (imageExtensions.test(url)) {
                addImage(url, 'network_request', 0, 0, '');
            } else if (initiatorType === 'img' || initiatorType === 'image') {
                // 如果initiatorType是img，也认为是图片（但已排除CSS/JS）
                addImage(url, 'network_request', 0, 0, '');
            }
        });
    } catch (e) {
    }

    return images;
}

// 加载图片尺寸信息
async function loadImageDimensions(images) {
    const promises = images.map(async img => {
        if (img.width && img.height) {
            return;
        }

        // 对于AVIF等新格式，使用增强的加载函数
        if (img.url.includes('.avif') || img.url.includes('avif') ||
            img.url.includes('.webp') || img.url.includes('webp')) {
            try {
                const result = await loadImageWithRetry(img.url);
                img.width = result.width;
                img.height = result.height;
            } catch (error) {
                img.width = 0;
                img.height = 0;
            }
            return;
        }

        // 对于其他格式，使用原有逻辑但增加重试
        return new Promise((resolve) => {
            const image = new Image();

            const timeout = setTimeout(() => {
                img.width = 0;
                img.height = 0;
                resolve();
            }, 10000);

            image.onload = () => {
                clearTimeout(timeout);
                img.width = image.naturalWidth;
                img.height = image.naturalHeight;
                resolve();
            };

            image.onerror = (error) => {
                clearTimeout(timeout);
                img.width = 0;
                img.height = 0;
                resolve();
            };

            if (img.url.startsWith('http') && !img.url.startsWith('data:')) {
                image.crossOrigin = 'anonymous';
            }

            image.src = img.url;
        });
    });

    await Promise.all(promises);
}

// 防抖定时器
let applyFiltersAndSortTimer = null;

// 应用筛选和排序
function applyFiltersAndSort() {
    if (!currentTabId) {
        filteredImages = [];
        renderImages(0);
        return;
    }

    // 保存当前选中的图片标识（基于URL+tabId，在排序前保存）
    const selectedKeys = new Set();
    selectedImages.forEach(index => {
        if (filteredImages[index]) {
            const img = filteredImages[index];
            const key = getDedupKeyFromUrl(img.url, img.tabId);
            selectedKeys.add(key);
        }
    });

    // 先进行去重（每次筛选前都去重，确保没有重复）
    const hasDuplicates = removeDuplicateImages();
    if (hasDuplicates) {
    }

    const sortType = sortSelect.value;

    // 仅处理当前标签页的图片
    const currentTabImages = allImages.filter(img => img.tabId === currentTabId);

    // 预先收集当前页的尺寸集合，用于自动补全筛选
    const currentSizes = new Set();
    currentTabImages.forEach(img => {
        if (img.width > 0 && img.height > 0) {
            currentSizes.add(`${Math.round(img.width)}×${Math.round(img.height)}`);
        }
    });

    // 若用户未主动清空，且未手动修改过筛选，则自动将当前页出现的尺寸加入筛选
    // 但只自动添加数量最多的前10个尺寸，避免自动选中太多尺寸
    if (!sizeFilterUserCleared && !sizeFilterUserModified) {
        // 统计每个尺寸的数量
        const sizeCountMap = {};
        currentTabImages.forEach(img => {
            if (img.width > 0 && img.height > 0) {
                const size = `${Math.round(img.width)}×${Math.round(img.height)}`;
                sizeCountMap[size] = (sizeCountMap[size] || 0) + 1;
            }
        });

        // 统计小尺寸数量
        let smallCount = 0;
        const regularSizes = {};
        Object.entries(sizeCountMap).forEach(([size, count]) => {
            const [wStr, hStr] = size.split('×');
            const w = parseInt(wStr, 10) || 0;
            const h = parseInt(hStr, 10) || 0;
            if (w <= 100 && h <= 100) {
                smallCount += count;
            } else {
                regularSizes[size] = count;
            }
        });

        // 按数量排序，只自动添加前10个数量最多的尺寸（不包括小尺寸）
        const sortedByCount = Object.entries(regularSizes)
            .sort((a, b) => b[1] - a[1]) // 按数量从多到少排序
            .slice(0, 10) // 只取前10个
            .map(([size]) => size);

        let added = false;
        // 如果小尺寸数量较多，也自动添加
        if (smallCount > 0) {
            if (!activeSizeFilters.has('small')) {
                activeSizeFilters.add('small');
                added = true;
            }
        }
        sortedByCount.forEach(size => {
            if (!activeSizeFilters.has(size)) {
                activeSizeFilters.add(size);
                added = true;
            }
        });
        if (added) {
            saveSizeFilterState();
        }
    }

    // 筛选（仅对DOM和Performance模式生效）
    filteredImages = currentTabImages.filter(img => {
        // 尺寸筛选
        // 如果用户主动清空且无选中尺寸，则不显示任何图片
        if (sizeFilterUserCleared && activeSizeFilters.size === 0) return false;
        // 正常情况：仅当有选中尺寸时限制
        if (activeSizeFilters.size > 0) {
            const width = Math.round(img.width);
            const height = Math.round(img.height);
            const imgSize = `${width}×${height}`;

            // 检查是否匹配选中的尺寸
            let matched = activeSizeFilters.has(imgSize);

            // 如果没匹配，检查是否是小尺寸（100×100以内）且选中了"小尺寸"选项
            if (!matched && width <= 100 && height <= 100 && activeSizeFilters.has('small')) {
                matched = true;
            }

            if (!matched) return false;
        }

        return true;
    });

    // 生成尺寸标签（仅基于当前标签页的图片），同时记录当前尺寸集合
    generateSizeTags(currentTabImages, currentSizes);

    // 排序：用户选择的排序方式作为主要排序，尺寸筛选排序作为次要排序
    const toNumber = (n) => Number.isFinite(n) ? n : 0;
    const sizeOrder = activeSizeFilters.size > 0 ? getSizeDisplayOrder() : [];

    filteredImages.sort((a, b) => {
        // 主要排序：用户选择的排序方式
        let primaryResult = 0;
        if (sortType === 'size-desc') {
            primaryResult = (toNumber(b.width) * toNumber(b.height)) - (toNumber(a.width) * toNumber(a.height));
        } else if (sortType === 'size-asc') {
            primaryResult = (toNumber(a.width) * toNumber(a.height)) - (toNumber(b.width) * toNumber(b.height));
        } else if (sortType === 'width-desc') {
            primaryResult = toNumber(b.width) - toNumber(a.width);
        } else if (sortType === 'height-desc') {
            primaryResult = toNumber(b.height) - toNumber(a.height);
        }

        // 如果主要排序结果不同，直接返回
        if (primaryResult !== 0) {
            return primaryResult;
        }

        // 主要排序结果相同（或未设置排序），使用尺寸筛选排序作为次要排序
        if (activeSizeFilters.size > 0 && sizeOrder.length > 0) {
            const aWidth = Math.round(a.width);
            const aHeight = Math.round(a.height);
            const bWidth = Math.round(b.width);
            const bHeight = Math.round(b.height);

            // 判断是否是小尺寸
            const aIsSmall = aWidth <= 100 && aHeight <= 100;
            const bIsSmall = bWidth <= 100 && bHeight <= 100;

            const aSize = aIsSmall ? 'small' : `${aWidth}×${aHeight}`;
            const bSize = bIsSmall ? 'small' : `${bWidth}×${bHeight}`;

            const aSel = activeSizeFilters.has(aSize);
            const bSel = activeSizeFilters.has(bSize);

            if (aSel !== bSel) return bSel - aSel;
            const aIdx = sizeOrder.indexOf(aSize);
            const bIdx = sizeOrder.indexOf(bSize);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
        }

        return 0;
    });

    // 排序后恢复选中状态（基于URL+tabId匹配）
    selectedImages.clear();
    filteredImages.forEach((img, index) => {
        const key = getDedupKeyFromUrl(img.url, img.tabId);
        if (selectedKeys.has(key)) {
            selectedImages.add(index);
        }
    });

    renderImages(filteredImages.length);
    updateStats();
}

// 获取尺寸标签的显示顺序
function getSizeDisplayOrder() {
    const sizeOrder = [];
    const sizeTags = document.querySelectorAll('.size-tag');
    sizeTags.forEach(tag => {
        const size = tag.dataset.size;
        if (size) {
            sizeOrder.push(size);
        }
    });
    return sizeOrder;
}

// 生成尺寸标签
function generateSizeTags(sourceImages = [], presetSizes = null) {
    // 统计每个尺寸的数量
    const sizeCount = {};
    const SMALL_SIZE_KEY = 'small'; // 小尺寸（100×100以内）的特殊标识
    let smallSizeCount = 0; // 小尺寸的图片数量

    sourceImages.forEach(img => {
        // 跳过无效尺寸
        if (img.width === 0 || img.height === 0) return;

        // 确保尺寸为整数
        const width = Math.round(img.width);
        const height = Math.round(img.height);

        // 如果是100×100以内的小尺寸，合并到"小尺寸"选项
        if (width <= 100 && height <= 100) {
            smallSizeCount++;
        } else {
            // 大于100×100的尺寸正常统计
            const size = `${width}×${height}`;
            sizeCount[size] = (sizeCount[size] || 0) + 1;
        }
    });

    // 如果有小尺寸图片，添加到统计中
    if (smallSizeCount > 0) {
        sizeCount[SMALL_SIZE_KEY] = smallSizeCount;
    }

    // 按选中状态优先，然后按数量从多到少排序（优先显示数量多的）
    const allSizes = Object.entries(sizeCount)
        .map(([size, count]) => {
            let area = 0;
            // 处理小尺寸选项
            if (size === SMALL_SIZE_KEY) {
                area = 0; // 小尺寸面积设为0，排在最前面
            } else {
                const [wStr, hStr] = size.split('×');
                const w = parseInt(wStr, 10) || 0;
                const h = parseInt(hStr, 10) || 0;
                area = w * h;
            }
            const isSelected = activeSizeFilters.has(size);
            return { size, count, area, isSelected };
        })
        .sort((a, b) => {
            // 选中的尺寸排在最前面
            if (a.isSelected !== b.isSelected) {
                return b.isSelected - a.isSelected;
            }
            // 小尺寸选项排在最前面（在未选中状态下）
            if (a.size === SMALL_SIZE_KEY && b.size !== SMALL_SIZE_KEY) return -1;
            if (a.size !== SMALL_SIZE_KEY && b.size === SMALL_SIZE_KEY) return 1;
            // 然后按数量从多到少排序（优先显示数量多的尺寸）
            if (b.count !== a.count) return b.count - a.count;
            // 数量相同时按面积从大到小排序
            if (b.area !== a.area) return b.area - a.area;
            return 0;
        });

    // 清空现有标签
    sizeTags.innerHTML = '';

    if (allSizes.length === 0) {
        sizeTagsContainer.style.display = 'none';
        return;
    }

    // 显示容器
    sizeTagsContainer.style.display = 'block';

    // 当前尺寸列表（如调用方已计算则复用）
    const currentSizes = presetSizes ? Array.from(presetSizes) : allSizes.map(item => item.size);

    // 限制显示数量：优先显示选中的尺寸和数量多的尺寸
    const MAX_DISPLAY = 30; // 最多显示30个尺寸
    const selectedSizes = allSizes.filter(item => item.isSelected);
    const unselectedSizes = allSizes.filter(item => !item.isSelected);

    // 选中的尺寸全部显示，未选中的按数量排序后取前N个
    const displaySizes = [
        ...selectedSizes,
        ...unselectedSizes.slice(0, MAX_DISPLAY - selectedSizes.length)
    ];

    // 生成标签（根据当前选中状态渲染）
    displaySizes.forEach(({ size, count }) => {
        const tag = document.createElement('button');
        tag.className = 'size-tag';
        tag.dataset.size = size;
        if (activeSizeFilters.has(size)) {
            tag.classList.add('active');
        }
        // 小尺寸显示为"小尺寸(≤100×100)"
        const displayName = size === SMALL_SIZE_KEY ? '小尺寸(≤100×100)' : size;
        tag.innerHTML = `
      <span>${displayName}</span>
      <span class="count">${count}</span>
    `;
        tag.addEventListener('click', () => toggleSizeFilter(size));
        sizeTags.appendChild(tag);
    });

    // 如果还有更多尺寸未显示，添加"显示更多"提示
    if (allSizes.length > MAX_DISPLAY) {
        const moreInfo = document.createElement('div');
        moreInfo.className = 'size-tag-more';
        moreInfo.style.cssText = 'padding: 8px 12px; color: #6c757d; font-size: 12px; text-align: center;';
        moreInfo.textContent = `还有 ${allSizes.length - MAX_DISPLAY} 个尺寸未显示（已显示数量最多的 ${MAX_DISPLAY} 个）`;
        sizeTags.appendChild(moreInfo);
    }

    // 更新清除按钮显示状态
    updateSizeFilterButtons();

    // 记录本次尺寸集合，用于后续判断是否需要自动加入新尺寸
    lastSizeSet = new Set(currentSizes);
}

// 切换尺寸筛选（多选模式）
function toggleSizeFilter(size) {
    const tag = document.querySelector(`[data-size="${size}"]`);

    if (activeSizeFilters.has(size)) {
        // 取消选中
        activeSizeFilters.delete(size);
        tag.classList.remove('active');
    } else {
        // 选中
        activeSizeFilters.add(size);
        tag.classList.add('active');
    }

    sizeFilterUserModified = true;
    sizeFilterUserCleared = activeSizeFilters.size === 0;

    // 保存选择状态
    saveSizeFilterState();
    updateSizeFilterButtons();

    // 调试信息

    applyFiltersAndSort();

    if (activeSizeFilters.size > 0) {
        showNotification(`已筛选 ${activeSizeFilters.size} 个尺寸`, 'info');
    } else {
        showNotification('已清除尺寸筛选，显示全部图片', 'info');
    }
}

// 保存尺寸筛选状态到本地存储
function saveSizeFilterState() {
    const state = Array.from(activeSizeFilters);
    localStorage.setItem('imageExtractor_sizeFilters', JSON.stringify(state));
}

// 从本地存储加载尺寸筛选状态
function loadSizeFilterState() {
    try {
        const saved = localStorage.getItem('imageExtractor_sizeFilters');
        if (saved) {
            const state = JSON.parse(saved);
            activeSizeFilters = new Set(state);
            // 只有用户点击“全不选”或“清除”时才设为true，加载时默认允许自动全选
            sizeFilterUserCleared = false;
            sizeFilterUserModified = false;
        } else {
            // 没有保存的状态时，清空筛选（显示所有图片）
            activeSizeFilters.clear();
            sizeFilterUserCleared = false;
            sizeFilterUserModified = false;
        }
    } catch (error) {
        // 出错时也清空筛选
        activeSizeFilters.clear();
        sizeFilterUserCleared = false;
        sizeFilterUserModified = false;
    }
}

// 全选所有尺寸
function selectAllSizes() {
    const allSizeTags = sizeTags.querySelectorAll('.size-tag');
    allSizeTags.forEach(tag => {
        const size = tag.dataset.size;
        activeSizeFilters.add(size);
        tag.classList.add('active');
    });

    sizeFilterUserCleared = false;
    sizeFilterUserModified = false; // 全选后允许自动补充新尺寸
    saveSizeFilterState();
    updateSizeFilterButtons();
    applyFiltersAndSort();
    showNotification(`已选中全部 ${activeSizeFilters.size} 个尺寸`, 'success');
}

// 全不选（清除所有尺寸筛选）
function deselectAllSizes() {
    activeSizeFilters.clear();
    sizeFilterUserCleared = true;
    sizeFilterUserModified = true;

    // 更新UI状态
    const allSizeTags = sizeTags.querySelectorAll('.size-tag');
    allSizeTags.forEach(tag => {
        tag.classList.remove('active');
    });

    saveSizeFilterState();
    updateSizeFilterButtons();
    applyFiltersAndSort();
    showNotification('已清除所有尺寸筛选，显示全部图片', 'info');
}

// 更新尺寸筛选按钮状态
function updateSizeFilterButtons() {
    // 更新清除筛选按钮显示
    if (activeSizeFilters.size > 0) {
        clearSizeFilterBtn.style.display = 'inline-block';
        clearSizeFilterBtn.textContent = `✕ 清除筛选 (${activeSizeFilters.size})`;
    } else {
        clearSizeFilterBtn.style.display = 'none';
    }
}

// 清除尺寸筛选（保留用于清除按钮）
function clearSizeFilter() {
    activeSizeFilters.clear();
    sizeFilterUserCleared = true;
    sizeFilterUserModified = true;
    saveSizeFilterState();
    updateSizeFilterButtons();
    applyFiltersAndSort();
    showNotification('已清除所有尺寸筛选', 'info');
}

// 隐藏该尺寸（等同于点击上方对应尺寸标签）
function hideThisImageSize(img) {
    const width = Math.round(img.width);
    const height = Math.round(img.height);
    // 如果是小尺寸，使用"small"标识，否则使用具体尺寸
    const size = (width <= 100 && height <= 100) ? 'small' : `${width}×${height}`;
    hideSize(size);
}

function hideSize(size) {
    const tag = document.querySelector(`[data-size="${size}"]`);

    if (tag) {
        // 若该尺寸当前处于选中，则点击以取消
        if (tag.classList.contains('active')) {
            tag.click();
            return;
        }
    }

    // 若当前没有任何选中的尺寸，则将所有已有尺寸设为选中，但排除该尺寸
    if (activeSizeFilters.size === 0) {
        const sizes = getSizeDisplayOrder();
        activeSizeFilters = new Set(sizes.filter(s => s !== size));
        saveSizeFilterState();
        // 重新渲染标签以同步UI的active状态
        generateSizeTags();
        updateSizeFilterButtons();
        applyFiltersAndSort();
        return;
    }

    // 若已有其它选中尺寸，确保该尺寸不在选中集合中
    if (activeSizeFilters.has(size)) {
        activeSizeFilters.delete(size);
        saveSizeFilterState();
        generateSizeTags();
        updateSizeFilterButtons();
        applyFiltersAndSort();
        return;
    }

    // 若该尺寸本就未选中但仍显示，说明没有尺寸筛选在起作用（不应发生）。
    // 作为兜底：将所有尺寸选中后移除该尺寸。
    const sizes = getSizeDisplayOrder();
    activeSizeFilters = new Set(sizes.filter(s => s !== size));
    saveSizeFilterState();
    generateSizeTags();
    updateSizeFilterButtons();
    applyFiltersAndSort();
}

// 渲染图片网格
function renderImages(totalImagesInTab = filteredImages.length) {
    imageGrid.innerHTML = '';

    // 清理不存在的选中项
    const validIndices = new Set(filteredImages.map((_, i) => i));
    selectedImages = new Set([...selectedImages].filter(i => validIndices.has(i)));

    if (filteredImages.length === 0 && totalImagesInTab > 0) {
        if (sizeFilterUserCleared && activeSizeFilters.size === 0) {
            imageGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #6c757d;">尺寸已全不选，当前不显示图片</div>';
        } else {
            imageGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #6c757d;">没有符合筛选条件的图片</div>';
        }
        updateStats();
        return;
    }

    filteredImages.forEach((img, index) => {
        const item = document.createElement('div');
        item.className = 'image-item';
        item.dataset.index = index;
        if (selectedImages.has(index)) {
            item.classList.add('selected');
        }

        const typeClass = `type-${img.type}`;
        const typeName = {
            'img': 'IMG',
            'background': '背景',
            'base64': 'Base64',
            'network_request': '网络'
        }[img.type] || '未知';

        // 提取图片名称
        const imageName = getImageName(img.url);
        const fileSize = getImageFileSize(img);

        item.innerHTML = `
      <div class="checkbox-overlay"></div>
      <div class="card-actions">
        <button class="hide-size-btn" title="隐藏此尺寸">🚫</button>
        <button class="download-btn" title="下载">💾</button>
      </div>
      <div class="image-wrapper">
        <img src="${img.url}" alt="${img.alt || '图片'}" loading="lazy">
      </div>
      <div class="image-info">
        <div class="image-name" title="${imageName}">${imageName}</div>
        <span class="image-type ${typeClass}">${typeName}</span>
        <div>尺寸: ${Math.round(img.width)} × ${Math.round(img.height)}</div>
        <div>大小: ${fileSize}</div>
      </div>
    `;

        // 点击选择/取消选择（支持Ctrl和Shift）
        item.addEventListener('click', (e) => {
            if (e.target.closest('.download-btn') || e.target.closest('.hide-size-btn')) {
                return;
            }
            handleImageClick(index, item, e);
        });

        // 单张下载
        const downloadBtn = item.querySelector('.download-btn');
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadImage(img, index);
        });

        // 隐藏该尺寸
        const hideSizeBtn = item.querySelector('.hide-size-btn');
        hideSizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            hideThisImageSize(img);
        });

        imageGrid.appendChild(item);
    });

    updateStats();
}

// 处理图片点击（支持快捷键）
function handleImageClick(index, element, event) {
    const ctrlKey = event.ctrlKey || event.metaKey; // Mac用户使用Cmd键
    const shiftKey = event.shiftKey;

    if (shiftKey && lastClickedIndex !== -1) {
        // Shift + 点击：范围选择
        selectRange(lastClickedIndex, index);
    } else if (ctrlKey) {
        // Ctrl + 点击：切换当前项，保持其他选择
        toggleImageSelection(index, element);
        lastClickedIndex = index;
    } else {
        // 普通点击：切换当前项
        toggleImageSelection(index, element);
        lastClickedIndex = index;
    }
}

// 范围选择
function selectRange(startIndex, endIndex) {
    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);

    // 选中范围内的所有图片
    for (let i = start; i <= end; i++) {
        if (!selectedImages.has(i)) {
            selectedImages.add(i);
        }
    }

    // 更新UI
    document.querySelectorAll('.image-item').forEach((item, idx) => {
        if (idx >= start && idx <= end) {
            item.classList.add('selected');
        }
    });

    updateStats();
    lastClickedIndex = endIndex;
}

// 切换图片选择状态
function toggleImageSelection(index, element) {
    if (selectedImages.has(index)) {
        selectedImages.delete(index);
        element.classList.remove('selected');
    } else {
        selectedImages.add(index);
        element.classList.add('selected');
    }
    updateStats();
}

// 更新统计信息
function updateStats() {
    imageCountSpan.textContent = `找到 ${filteredImages.length} 张图片`;
    selectedCountSpan.textContent = `已选择 ${selectedImages.size} 张`;
    downloadSelectedBtn.disabled = selectedImages.size === 0;
    downloadSelectedBtn.textContent = `💾 下载选中 (${selectedImages.size})`;
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// 归一化图片URL用于去重
// 处理URL编码差异、空格等边缘情况，但保留查询参数
function normalizeImageUrl(url) {
    try {
        if (url.startsWith('data:')) {
            // 对于base64图片，使用完整的data URL作为key（因为可能内容不同）
            return url;
        }

        // 先解码URL，然后重新编码，统一编码格式
        let normalized = decodeURIComponent(url);
        // 去除首尾空格
        normalized = normalized.trim();

        // 尝试解析为URL对象，统一格式
        try {
            const u = new URL(normalized);
            // 保留完整的URL（包括查询参数和hash），但统一编码
            normalized = u.href;
        } catch (e) {
            // 如果无法解析为URL，使用原始值
        }

        // 转换为小写
        return normalized.toLowerCase();
    } catch (e) {
        // URL解析失败，使用原始URL的小写形式（去除空格）
        return url.trim().toLowerCase();
    }
}

function getDedupKeyFromUrl(url, tabId = null) {
    const normalizedUrl = normalizeImageUrl(url);
    // 如果提供了tabId，将其包含在去重key中，避免不同标签页的相同URL被误判为重复
    if (tabId !== null && tabId !== undefined) {
        return `${normalizedUrl}::tab:${tabId}`;
    }
    return normalizedUrl;
}

// 去重函数 - 移除重复的图片（同一标签页内的重复）
function removeDuplicateImages() {
    const seenKeys = new Set(); // 基于完整URL的去重
    const seenFileKeys = new Set(); // 基于文件名+尺寸+标签页的去重（更严格）
    const uniqueImages = [];
    let removedCount = 0;
    const duplicateKeys = new Set(); // 记录重复的key，用于调试

    allImages.forEach((img, index) => {
        // 主要去重：使用URL和tabId组合作为去重key
        const key = getDedupKeyFromUrl(img.url, img.tabId);

        // 辅助去重：基于文件名+尺寸+标签页（更严格，忽略查询参数）
        let fileKey = null;
        if (img.width > 0 && img.height > 0) {
            try {
                const fileName = getImageName(img.url);
                // 使用文件名+尺寸+标签页作为去重key
                fileKey = `${fileName}::${img.width}×${img.height}::tab:${img.tabId}`.toLowerCase();
            } catch (e) {
                // 获取文件名失败，跳过辅助去重
            }
        }

        // 检查是否重复
        const isUrlDuplicate = seenKeys.has(key);
        const isFileDuplicate = fileKey && seenFileKeys.has(fileKey);

        if (isUrlDuplicate || isFileDuplicate) {
            // 发现重复
            removedCount++;
            duplicateKeys.add(key);
            if (isUrlDuplicate) {
            }
            return; // 跳过这个图片
        }

        // 不是重复，添加到结果
        seenKeys.add(key);
        if (fileKey) {
            seenFileKeys.add(fileKey);
        }
        uniqueImages.push(img);
    });

    if (removedCount > 0) {
        allImages = uniqueImages;
        return true;
    }
    return false;
}

// 从URL中提取图片名称
function getImageName(url) {
    try {
        if (url.startsWith('data:')) {
            // Base64图片，使用默认名称
            return 'Base64图片';
        }

        // 从URL中提取文件名
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();

        if (filename && filename.includes('.')) {
            // 有扩展名的文件名
            return filename;
        } else if (pathname) {
            // 没有扩展名，使用路径的最后一部分
            const pathParts = pathname.split('/').filter(part => part);
            return pathParts[pathParts.length - 1] || '图片';
        } else {
            // 使用域名作为名称
            return urlObj.hostname;
        }
    } catch (error) {
        // URL解析失败，返回默认名称
        return '图片';
    }
}

// 获取图片文件大小
function getImageFileSize(img) {
    try {
        if (img.url.startsWith('data:')) {
            // Base64图片，计算实际字节数
            const base64Data = img.url.split(',')[1];
            if (base64Data) {
                const bytes = (base64Data.length * 3) / 4;
                return formatFileSize(bytes);
            }
        }

        // 对于网络图片，使用URL长度作为估算
        // 注意：这不是准确的文件大小，只是估算
        return formatFileSize(img.url.length);
    } catch (error) {
        return '未知大小';
    }
}

// 下载单张图片
async function downloadImage(img, index, timestamp = null) {
    try {
        // 如果没有提供时间戳，使用当前时间
        const time = timestamp || Date.now();

        // 尝试使用原始文件名，如果无法获取则使用默认名称
        let filename;
        try {
            const imageName = getImageName(img.url);
            // 如果文件名有效且不是默认名称，使用原始文件名
            if (imageName && imageName !== '图片' && imageName !== 'Base64图片') {
                // 清理文件名，移除非法字符
                const cleanName = imageName.replace(/[<>:"/\\|?*]/g, '_');
                filename = `${cleanName}`;
            } else {
                filename = `image_${time}_${index}.${getImageExtension(img.url)}`;
            }
        } catch (e) {
            filename = `image_${time}_${index}.${getImageExtension(img.url)}`;
        }

        if (img.url.startsWith('data:')) {
            downloadBase64Image(img.url, filename);
        } else {
            chrome.downloads.download({
                url: img.url,
                filename: filename,
                saveAs: false
            });
        }
    } catch (error) {
        throw error; // 抛出错误，让调用者处理
    }
}

// 下载 Base64 图片
function downloadBase64Image(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 获取图片扩展名
function getImageExtension(url) {
    if (url.startsWith('data:image/')) {
        const match = url.match(/data:image\/(\w+)/);
        return match ? match[1] : 'png';
    }

    const match = url.match(/\.(\w+)(?:\?|$)/);
    return match ? match[1] : 'png';
}

// 增强的图片加载函数，专门处理AVIF等新格式
async function loadImageWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const image = new Image();

                // 设置更长的超时时间
                const timeout = setTimeout(() => {
                    reject(new Error('图片加载超时'));
                }, 15000);

                image.onload = () => {
                    clearTimeout(timeout);
                    resolve({
                        width: image.naturalWidth,
                        height: image.naturalHeight,
                        success: true
                    });
                };

                image.onerror = (error) => {
                    clearTimeout(timeout);
                    reject(error);
                };

                // 设置跨域属性
                if (url.startsWith('http') && !url.startsWith('data:')) {
                    image.crossOrigin = 'anonymous';
                }

                image.src = url;
            });
        } catch (error) {
            if (attempt === maxRetries) {
                return { width: 0, height: 0, success: false };
            }
            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// 批量下载选中的图片
async function downloadSelected() {
    if (selectedImages.size === 0) return;

    downloadSelectedBtn.disabled = true;
    const originalText = downloadSelectedBtn.textContent;
    downloadSelectedBtn.textContent = '下载中...';

    // 收集要下载的图片，使用URL+tabId去重，避免重复下载
    const downloadSet = new Set();
    const imagesToDownload = [];

    for (const index of selectedImages) {
        // 检查索引是否有效
        if (index < 0 || index >= filteredImages.length) {
            continue;
        }

        const img = filteredImages[index];
        if (!img) {
            continue;
        }

        // 使用URL+tabId作为唯一标识，避免重复下载
        const key = getDedupKeyFromUrl(img.url, img.tabId);
        if (!downloadSet.has(key)) {
            downloadSet.add(key);
            imagesToDownload.push({ img, index });
        } else {
        }
    }


    let count = 0;
    let successCount = 0;
    let failCount = 0;
    const baseTime = Date.now(); // 使用基础时间戳，避免文件名冲突

    for (let i = 0; i < imagesToDownload.length; i++) {
        const { img, index } = imagesToDownload[i];
        try {
            // 使用索引和序号确保文件名唯一
            await downloadImage(img, index, baseTime + i);
            successCount++;
        } catch (error) {
            failCount++;
        }
        count++;

        downloadSelectedBtn.textContent = `下载中... (${count}/${imagesToDownload.length})`;

        // 添加延迟避免下载过快
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    downloadSelectedBtn.textContent = originalText;
    downloadSelectedBtn.disabled = false;

    if (failCount > 0) {
        showNotification(`下载完成：成功 ${successCount} 张，失败 ${failCount} 张`, failCount === imagesToDownload.length ? 'error' : 'info');
    } else {
        showNotification(`成功下载 ${successCount} 张图片！`, 'success');
    }
}

// 全选
function selectAll() {
    selectedImages.clear();
    filteredImages.forEach((_, index) => {
        selectedImages.add(index);
    });

    document.querySelectorAll('.image-item').forEach(item => {
        item.classList.add('selected');
    });

    updateStats();
}

// 取消全选
function deselectAll() {
    selectedImages.clear();

    document.querySelectorAll('.image-item').forEach(item => {
        item.classList.remove('selected');
    });

    updateStats();
}

// 反选
function invertSelection() {
    const newSelection = new Set();

    filteredImages.forEach((_, index) => {
        if (!selectedImages.has(index)) {
            newSelection.add(index);
        }
    });

    selectedImages = newSelection;

    document.querySelectorAll('.image-item').forEach((item, index) => {
        if (selectedImages.has(index)) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });

    updateStats();
}

// 清空所有图片
async function clearAll() {
    if (allImages.length === 0) return;

    if (confirm(`确定要清空所有 ${allImages.length} 张图片吗？`)) {
        // 停止监听
        const selectedTabId = parseInt(tabSelect.value);
        if (selectedTabId) {
            chrome.runtime.sendMessage({ action: 'stopNetworkInterceptor' }).catch(() => { });
        }

        // 清除尺寸筛选
        activeSizeFilters.clear();
        clearSizeFilterBtn.style.display = 'none';
        sizeTagsContainer.style.display = 'none';

        allImages = [];
        filteredImages = [];
        selectedImages.clear();
        lastClickedIndex = -1;
        imageGrid.innerHTML = '';
        emptyState.style.display = 'flex';
        emptyState.innerHTML = `
      <div class="empty-icon">🖼️</div>
      <h2>已清空</h2>
      <p>点击右上角的「提取当前页面图片」按钮重新开始</p>
    `;
        updateStats();
    }
}

// 显示通知
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
    position: fixed;
    top: 80px;
    right: 30px;
    background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#667eea'};
    color: white;
    padding: 15px 25px;
    border-radius: 10px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    z-index: 10000;
    font-weight: 500;
    animation: slideIn 0.3s ease;
  `;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// 测试快速筛选功能
function testSizeFilter() {
    console.log('=== 快速筛选功能测试 ===');
    console.log('当前activeSizeFilters:', Array.from(activeSizeFilters));
    console.log('当前allImages数量:', allImages.length);
    console.log('当前filteredImages数量:', filteredImages.length);

    if (allImages.length > 0) {
        console.log('图片尺寸统计:');
        const sizeCount = {};
        allImages.forEach(img => {
            if (img.width > 0 && img.height > 0) {
                const size = `${img.width}×${img.height}`;
                sizeCount[size] = (sizeCount[size] || 0) + 1;
            }
        });
        console.log(sizeCount);
    }
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init);

// 网络请求监听相关函数
function setupNetworkMonitoring() {
    // 监听来自content script和background script的消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'newImage') {
            // WebRequest模式：拦截器拦截到新图片，实时添加
            if (captureMode === 'webrequest' && request.data) {
                const { url, tabId } = request.data;
                if (url) {
                    // 检查图片是否属于当前选中的标签页
                    const selectedTabId = parseInt(tabSelect.value);

                    if (selectedTabId) {
                        // 拦截器是针对当前选中标签页启动的，拦截到的图片都应该是该标签页的
                        // 如果tabId匹配，直接添加；如果tabId为-1或未定义，也默认添加（可能是CDN资源）
                        // 如果tabId不匹配且不是-1，说明是其他标签页的请求，跳过
                        if (tabId === selectedTabId || tabId === -1 || !tabId) {
                            // tabId匹配或无法确定，直接添加
                            handleNewInterceptedImage(url, selectedTabId);
                        }
                        // tabId不匹配且不是-1，说明是其他标签页的请求，跳过
                    } else {
                        // 没有选中标签页，默认添加
                        handleNewInterceptedImage(url, tabId || currentTabId);
                    }
                }
            }
        }
        return true; // 保持消息通道开放
    });
}

// 监听标签页导航完成，自动重新提取并重启监听
function setupTabUpdateWatcher() {
    let tabUpdateTimer = null;
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (tabId !== currentTabId) return;

        // 对于WebRequest模式，需要在页面开始加载时（status === 'loading'）就启动拦截器
        // 否则会错过初始的图片请求
        if (changeInfo.status === 'loading' && captureMode === 'webrequest') {
            // 检查是否是域名变化（跨站点），而不是同一站内路径变化
            // 只在域名变化时才清空数据
            let currentUrl = null;
            try {
                if (tab && tab.url) {
                    currentUrl = tab.url;
                } else if (changeInfo.url) {
                    currentUrl = changeInfo.url;
                }
            } catch (e) {
                // 忽略错误
            }

            let currentHost = null;
            try {
                if (currentUrl) {
                    currentHost = new URL(currentUrl).hostname;
                }
            } catch (e) {
                // 忽略解析错误，视为无效URL
            }

            if (currentHost && currentHost !== lastTabUrl) {
                // 域名变化了，说明是切换到不同站点，清空所有图片数据
                lastTabUrl = currentHost;
                allImages = [];
                filteredImages = [];
                selectedImages.clear();
                renderImages(0);
                updateStats();

                // 重置汇总数据
                resetSummary();

                // 清空拦截记录并启动拦截器
                chrome.runtime.sendMessage({
                    action: 'startNetworkInterceptor',
                    tabId: tabId,
                    clearPrevious: true // 清空之前的拦截记录
                }).catch(() => { });
            } else {
                // URL没变化或无法获取URL，可能是网页内的tab切换，不清空数据，只确保拦截器运行
                chrome.runtime.sendMessage({
                    action: 'startNetworkInterceptor',
                    tabId: tabId,
                    clearPrevious: false // 不清空，保持已有记录
                }).catch(() => { });
            }
        }

        if (changeInfo.status === 'complete') {
            // 防抖，避免同一加载过程多次触发
            if (tabUpdateTimer) clearTimeout(tabUpdateTimer);
            tabUpdateTimer = setTimeout(async () => {
                const selectedTabId = parseInt(tabSelect.value);
                if (selectedTabId) {
                    if (captureMode === 'performance') {
                        // Performance模式：提取一次并启动监听
                        removeDuplicateImages();
                        await extractImagesFromCurrentTab();
                        chrome.runtime.sendMessage({
                            action: 'startNetworkInterceptor',
                            tabId: selectedTabId,
                            clearPrevious: false // 不清空，保持已有记录
                        }).catch(() => { });
                        chrome.tabs.sendMessage(selectedTabId, { action: 'startNetworkMonitoring' }).catch(() => { });
                    } else if (captureMode === 'webrequest') {
                        // WebRequest模式：不主动提取，只确保拦截器运行
                        // 图片会通过拦截器实时添加到列表中
                        // 拦截器已经在loading阶段启动并清空了记录
                    }
                }
            }, 1000); // 增加延迟，减少频繁刷新导致的抖动
        }
    });
}

// 打印汇总信息
function printSummary() {
    // 统计去重后的实际图片（allImages已经去重）
    const totalImages = allImages.filter(img => img.tabId === currentTabId);
    const displayedImages = filteredImages.filter(img => img.tabId === currentTabId);

    // 统计第一波和第二波中实际存在的图片（去重后）
    const firstWaveActual = firstWaveImages.filter(img => {
        return totalImages.some(totalImg =>
            getDedupKeyFromUrl(totalImg.url, totalImg.tabId) === getDedupKeyFromUrl(img.url, img.tabId)
        );
    });
    const secondWaveActual = secondWaveImages.filter(img => {
        return totalImages.some(totalImg =>
            getDedupKeyFromUrl(totalImg.url, totalImg.tabId) === getDedupKeyFromUrl(img.url, img.tabId)
        );
    });

    // 找出被过滤掉的图片（用于调试）
    const filteredOut = totalImages.filter(img => {
        return !displayedImages.some(displayedImg =>
            getDedupKeyFromUrl(displayedImg.url, displayedImg.tabId) === getDedupKeyFromUrl(img.url, img.tabId)
        );
    });

    const summary = {
        本地拦截到的图片数组: totalImages.map(img => ({
            url: img.url,
            width: img.width,
            height: img.height,
            type: img.type
        })),
        总数量: totalImages.length,
        页面显示数量: displayedImages.length,
        被过滤掉的图片: filteredOut.length > 0 ? filteredOut.map(img => ({
            url: img.url,
            width: img.width,
            height: img.height,
            type: img.type
        })) : [],
        第一波: {
            图片数组: firstWaveActual.map(img => ({
                url: img.url,
                width: img.width,
                height: img.height,
                type: img.type
            })),
            数量: firstWaveActual.length,
            原始拦截数量: firstWaveImages.length
        },
        第二波: {
            图片数组: secondWaveActual.map(img => ({
                url: img.url,
                width: img.width,
                height: img.height,
                type: img.type
            })),
            数量: secondWaveActual.length,
            原始拦截数量: secondWaveImages.length
        }
    };

    console.log(summary);
}

// 重置汇总数据（仅在页面URL变化时调用）
function resetSummary() {
    firstWaveImages = [];
    secondWaveImages = [];
    isFirstWave = true;
    pageLoadStartTime = Date.now();
    if (summaryTimer) {
        clearTimeout(summaryTimer);
        summaryTimer = null;
    }
}

// 存储每个标签页的域名（hostname），用于检测“跨站点”变化
// 只在域名变更时清空数据，同一域名下路径变化不清空
let lastTabUrl = null;

// 处理新拦截到的图片
async function handleNewInterceptedImage(url, tabId) {
    let dedupKey = null;
    try {
        const targetTabId = tabId || currentTabId;

        // 没有标签页时不处理，防止 undefined 报错
        if (!targetTabId) {
            return;
        }

        // 防止重复处理
        dedupKey = getDedupKeyFromUrl(url, targetTabId);
        if (processingImages.has(dedupKey)) {
            return;
        }

        // 检查是否已存在
        const existingKeys = new Set(allImages.map(img => getDedupKeyFromUrl(img.url, img.tabId)));
        if (existingKeys.has(dedupKey)) {
            return;
        }

        processingImages.add(dedupKey);

        // 根据过滤模式检查图片
        if (filterMode === 'blacklist') {
            // 黑名单模式：检查是否在黑名单中
            if (isBlacklisted(url)) {
                return;
            }
        } else if (filterMode === 'whitelist') {
            // 白名单模式：检查是否在白名单中
            if (!isWhitelisted(url)) {
                return;
            }
        }

        // 创建图片对象
        const img = {
            url: url,
            type: 'network_request',
            tabId: targetTabId,
            width: 0,
            height: 0,
            alt: ''
        };

        // 加载图片尺寸
        await loadImageDimensions([img]);

        // 加载尺寸后再次检查是否已存在（防止在加载期间被其他途径添加）
        const existingKeysAfterLoad = new Set(allImages.map(img => getDedupKeyFromUrl(img.url, img.tabId)));
        if (existingKeysAfterLoad.has(dedupKey)) {
            return;
        }

        // 保存当前选中的图片标识（基于URL+tabId，更可靠）
        const selectedKeys = new Set();
        selectedImages.forEach(index => {
            if (filteredImages[index]) {
                const img = filteredImages[index];
                const key = getDedupKeyFromUrl(img.url, img.tabId);
                selectedKeys.add(key);
            }
        });

        allImages.push(img);

        // 判断是第一波还是第二波
        // 第一波：页面加载开始后30秒内的图片
        // 第二波：30秒后的新请求
        const now = Date.now();
        const timeSincePageLoad = pageLoadStartTime ? (now - pageLoadStartTime) : 0;

        if (timeSincePageLoad > 30000) {
            // 超过30秒，认为是第二波
            if (isFirstWave) {
                isFirstWave = false;
                console.log('页面有新请求 第二波');
            }
            secondWaveImages.push(img);
        } else {
            // 30秒内，第一波
            firstWaveImages.push(img);
        }

        // 重置汇总定时器（6000ms无新图片后打印）
        if (summaryTimer) {
            clearTimeout(summaryTimer);
        }
        summaryTimer = setTimeout(() => {
            printSummary();
        }, 6000);

        // 立即进行去重检查（防止并发添加导致的重复）
        removeDuplicateImages();

        // 静默更新，使用防抖避免频繁刷新
        if (applyFiltersAndSortTimer) clearTimeout(applyFiltersAndSortTimer);
        applyFiltersAndSortTimer = setTimeout(() => {
            applyFiltersAndSort();
        }, 200);

        // 恢复之前选中的图片（使用URL+tabId匹配，更准确）
        selectedImages.clear();
        filteredImages.forEach((img, index) => {
            const key = getDedupKeyFromUrl(img.url, img.tabId);
            if (selectedKeys.has(key)) {
                selectedImages.add(index);
            }
        });

        // 更新UI显示选中状态
        document.querySelectorAll('.image-item').forEach((item, index) => {
            if (selectedImages.has(index)) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });

        // 只在第一次添加时显示通知（当前标签页只有这一张图片时）
        const currentTabImageCount = allImages.filter(img => img.tabId === currentTabId).length;
        if (targetTabId === currentTabId && currentTabImageCount === 1) {
            showNotification(`网络监听发现新图片: ${url.substring(0, 50)}...`, 'success');
        }
    } catch (error) {
        // 静默失败
    } finally {
        // 清理处理状态
        if (dedupKey) {
            processingImages.delete(dedupKey);
        }
    }
}

// 启动网络请求监听
async function startNetworkMonitoring() {
    try {
        console.log(`[ImageCapture] 启动网络请求监听`);

        // 启动background script的网络拦截
        await chrome.runtime.sendMessage({ action: 'startNetworkInterceptor' });
        console.log(`[ImageCapture] Background 网络拦截已启动`);

        // 启动content script的网络监听
        const selectedTabId = parseInt(tabSelect.value);

        if (selectedTabId) {
            try {
                await chrome.tabs.sendMessage(selectedTabId, { action: 'startNetworkMonitoring' });
                console.log(`[ImageCapture] Content script 网络监听已启动 (tabId: ${selectedTabId})`);
            } catch (error) {
                console.error(`[ImageCapture] 启动 content script 监听失败 (tabId: ${selectedTabId}):`, error.message);
                // 即使content script失败，background script仍然可以工作
            }
        }

        networkMonitoringEnabled = true;
    } catch (error) {
        console.error(`[ImageCapture] 启动网络监听失败:`, error);
    }
}

// 停止网络请求监听
async function stopNetworkMonitoring() {
    try {
        // 停止background script的网络拦截
        await chrome.runtime.sendMessage({ action: 'stopNetworkInterceptor' });

        // 停止content script的网络监听
        const selectedTabId = parseInt(tabSelect.value);
        if (selectedTabId) {
            await chrome.tabs.sendMessage(selectedTabId, { action: 'stopNetworkMonitoring' });
        }

        networkMonitoringEnabled = false;
        console.log(`[ImageCapture] 网络请求监听已停止`);
    } catch (error) {
        console.error(`[ImageCapture] 停止网络监听失败:`, error);
    }
}

// 获取拦截到的图片
async function getInterceptedImages() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getInterceptedImages' });
        if (response.success) {
            return response.images;
        }
    } catch (error) {
        console.error('获取拦截图片失败:', error);
    }
    return [];
}

// 清除拦截的图片
async function clearInterceptedImages() {
    try {
        await chrome.runtime.sendMessage({ action: 'clearInterceptedImages' });
        interceptedImages.clear();
    } catch (error) {
        console.error('清除拦截图片失败:', error);
    }
}

// 测试自动选择功能
async function testAutoSelect() {
    console.log('=== 测试自动选择功能 ===');

    // 获取当前活跃标签页
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('当前活跃标签页:', activeTab);

    // 获取所有标签页
    const tabs = await chrome.tabs.query({});
    console.log('所有标签页数量:', tabs.length);

    // 过滤有效标签页
    const validTabs = tabs.filter(tab =>
        !tab.url.startsWith('chrome://') &&
        !tab.url.startsWith('chrome-extension://') &&
        !tab.url.startsWith('edge://') &&
        !tab.url.startsWith('about:')
    );
    console.log('有效标签页数量:', validTabs.length);

    // 检查当前选中的标签页
    const selectedTabId = parseInt(tabSelect.value);
    console.log('当前选中的标签页ID:', selectedTabId);

    return {
        activeTab,
        validTabs,
        selectedTabId
    };
}

// 测试网络监听功能
async function testNetworkMonitoring() {
    console.log('=== 测试网络监听功能 ===');
    console.log('当前拦截的图片数量:', interceptedImages.size);
    console.log('当前图片列表数量:', allImages.length);
    console.log('当前筛选后的图片数量:', filteredImages.length);
    console.log('网络监听状态:', networkMonitoringEnabled);
    console.log('自动提取状态:', autoExtractEnabled);
    console.log('当前选中的标签页ID:', parseInt(tabSelect.value));

    // 获取拦截到的图片
    const intercepted = await getInterceptedImages();
    console.log('Background中拦截的图片:', intercepted);

    return {
        interceptedImages: Array.from(interceptedImages),
        allImages: allImages.length,
        filteredImages: filteredImages.length,
        backgroundIntercepted: intercepted,
        networkMonitoringEnabled,
        autoExtractEnabled
    };
}

// 手动触发图片提取（用于测试）
async function manualExtract() {
    console.log('手动触发图片提取...');
    const selectedTabId = parseInt(tabSelect.value);
    if (selectedTabId) {
        await extractImagesFromCurrentTab();
    } else {
        console.log('没有选中标签页');
    }
}

// 处理所有已拦截的图片
async function processAllInterceptedImages() {
    console.log('开始处理所有已拦截的图片...');
    const intercepted = await getInterceptedImages();
    console.log('获取到拦截的图片数量:', intercepted.length);

    let processedCount = 0;
    for (const imgData of intercepted) {
        try {
            await handleNewInterceptedImage(imgData.url);
            processedCount++;
        } catch (error) {
            console.error('处理图片失败:', imgData.url, error);
        }
    }

    console.log(`已处理 ${processedCount} 张图片`);
    return processedCount;
}

// 黑名单相关函数
function isBlacklisted(url) {
    for (const keyword of blacklistKeywords) {
        if (url.toLowerCase().includes(keyword.toLowerCase())) {
            return true;
        }
    }
    return false;
}

function addBlacklistKeyword() {
    const keyword = blacklistInput.value.trim();
    if (!keyword) {
        showNotification('请输入关键字', 'error');
        return;
    }

    if (blacklistKeywords.has(keyword)) {
        showNotification('关键字已存在', 'error');
        return;
    }

    blacklistKeywords.add(keyword);
    blacklistInput.value = '';
    saveBlacklistState();
    renderBlacklistTags();
    applyFiltersAndSort(); // 重新筛选，移除黑名单图片
    showNotification(`已添加黑名单关键字: ${keyword}`, 'success');
}

function removeBlacklistKeyword(keyword) {
    blacklistKeywords.delete(keyword);
    saveBlacklistState();
    renderBlacklistTags();
    applyFiltersAndSort(); // 重新筛选
    showNotification(`已移除黑名单关键字: ${keyword}`, 'info');
}

function renderBlacklistTags() {
    blacklistTags.innerHTML = '';

    blacklistKeywords.forEach(keyword => {
        const tag = document.createElement('div');
        tag.className = 'blacklist-tag';

        const span = document.createElement('span');
        span.textContent = keyword;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => removeBlacklistKeyword(keyword));

        tag.appendChild(span);
        tag.appendChild(removeBtn);
        blacklistTags.appendChild(tag);
    });
}

function saveBlacklistState() {
    const state = Array.from(blacklistKeywords);
    localStorage.setItem('imageExtractor_blacklist', JSON.stringify(state));
}

function loadBlacklistState() {
    try {
        const saved = localStorage.getItem('imageExtractor_blacklist');
        if (saved) {
            const state = JSON.parse(saved);
            blacklistKeywords = new Set(state);
            renderBlacklistTags();
            console.log('加载黑名单状态:', Array.from(blacklistKeywords));
        }
    } catch (error) {
        console.error('加载黑名单状态失败:', error);
    }
}

// 白名单相关函数
function isWhitelisted(url) {
    for (const keyword of whitelistKeywords) {
        if (url.toLowerCase().includes(keyword.toLowerCase())) {
            return true;
        }
    }
    return false;
}

function addWhitelistKeyword() {
    const keyword = whitelistInput.value.trim();
    if (!keyword) {
        showNotification('请输入关键字', 'error');
        return;
    }

    if (whitelistKeywords.has(keyword)) {
        showNotification('关键字已存在', 'error');
        return;
    }

    whitelistKeywords.add(keyword);
    whitelistInput.value = '';
    saveWhitelistState();
    renderWhitelistTags();
    applyFiltersAndSort(); // 重新筛选
    showNotification(`已添加白名单关键字: ${keyword}`, 'success');
}

function removeWhitelistKeyword(keyword) {
    whitelistKeywords.delete(keyword);
    saveWhitelistState();
    renderWhitelistTags();
    applyFiltersAndSort(); // 重新筛选
    showNotification(`已移除白名单关键字: ${keyword}`, 'info');
}

function renderWhitelistTags() {
    whitelistTags.innerHTML = '';

    whitelistKeywords.forEach(keyword => {
        const tag = document.createElement('div');
        tag.className = 'whitelist-tag';

        const span = document.createElement('span');
        span.textContent = keyword;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => removeWhitelistKeyword(keyword));

        tag.appendChild(span);
        tag.appendChild(removeBtn);
        whitelistTags.appendChild(tag);
    });
}

function saveWhitelistState() {
    const state = Array.from(whitelistKeywords);
    localStorage.setItem('imageExtractor_whitelist', JSON.stringify(state));
}

function loadWhitelistState() {
    try {
        const saved = localStorage.getItem('imageExtractor_whitelist');
        if (saved) {
            const state = JSON.parse(saved);
            whitelistKeywords = new Set(state);
            renderWhitelistTags();
            console.log('加载白名单状态:', Array.from(whitelistKeywords));
        }
    } catch (error) {
        console.error('加载白名单状态失败:', error);
    }
}

// 过滤模式相关函数
function toggleFilterModeUI() {
    if (filterMode === 'blacklist') {
        blacklistRow.style.display = 'block';
        whitelistRow.style.display = 'none';
    } else if (filterMode === 'whitelist') {
        blacklistRow.style.display = 'none';
        whitelistRow.style.display = 'block';
    }
}

function saveFilterModeState() {
    localStorage.setItem('imageExtractor_filterMode', filterMode);
}

function loadFilterModeState() {
    try {
        const saved = localStorage.getItem('imageExtractor_filterMode');
        if (saved) {
            filterMode = saved;
            // 设置单选按钮状态
            const radio = document.querySelector(`input[name="filterMode"][value="${filterMode}"]`);
            if (radio) {
                radio.checked = true;
            }
            toggleFilterModeUI();
            console.log('加载过滤模式状态:', filterMode);
        }
    } catch (error) {
        console.error('加载过滤模式状态失败:', error);
    }
}

// 添加测试函数到全局作用域，方便调试
window.testSizeFilter = testSizeFilter;
window.startNetworkMonitoring = startNetworkMonitoring;
window.stopNetworkMonitoring = stopNetworkMonitoring;
window.getInterceptedImages = getInterceptedImages;
window.testAutoSelect = testAutoSelect;
window.testNetworkMonitoring = testNetworkMonitoring;
window.manualExtract = manualExtract;
window.processAllInterceptedImages = processAllInterceptedImages;

// 测试处理拦截图片的函数
window.testHandleInterceptedImage = async function (url) {
    console.log('测试处理拦截图片:', url);
    await handleNewInterceptedImage(url);
};

// 检查当前状态
window.checkStatus = function () {
    console.log('当前状态:');
    console.log('- 过滤模式:', filterMode);
    console.log('- 黑名单关键字:', Array.from(blacklistKeywords));
    console.log('- 白名单关键字:', Array.from(whitelistKeywords));
    console.log('- 当前图片数量:', allImages.length);
    console.log('- 拦截图片数量:', interceptedImages.size);
    console.log('- 选中的标签页ID:', tabSelect.value);
    console.log('- 当前标签页ID:', currentTabId);
};

// 调试标签页选择
window.debugTabSelection = async function () {
    console.log('=== 调试标签页选择 ===');

    // 获取所有标签页
    const allTabs = await chrome.tabs.query({});
    console.log('所有标签页:', allTabs.map(tab => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        lastAccessed: tab.lastAccessed
    })));

    // 获取当前活跃标签页
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        console.log('当前活跃标签页:', activeTab);
    } catch (error) {
        console.log('无法获取活跃标签页:', error);
    }

    // 重新加载标签页
    console.log('重新加载标签页...');
    await loadAvailableTabs();
};

// 重置尺寸筛选状态
window.resetSizeFilter = function () {
    activeSizeFilters.clear();
    saveSizeFilterState();
    applyFiltersAndSort();
    showNotification('已重置尺寸筛选状态', 'info');
    console.log('尺寸筛选状态已重置');
};

// 调试图片排序
window.debugImageSort = function () {
    console.log('=== 调试图片排序 ===');
    console.log('当前图片数量:', filteredImages.length);
    console.log('选中的尺寸:', Array.from(activeSizeFilters));
    console.log('尺寸标签顺序:', getSizeDisplayOrder());

    // 显示前10张图片的尺寸信息
    filteredImages.slice(0, 10).forEach((img, index) => {
        const size = `${Math.round(img.width)}×${Math.round(img.height)}`;
        const isSelected = activeSizeFilters.has(size);
        console.log(`图片${index + 1}: ${size} (选中: ${isSelected})`);
    });
};

// 调试网络监听状态
window.debugNetworkMonitoring = function () {
    console.log('=== 调试网络监听状态 ===');
    console.log('网络监听启用:', networkMonitoringEnabled);
    console.log('拦截图片数量:', interceptedImages.size);
    console.log('正在处理的图片:', Array.from(processingImages));
    console.log('总图片数量:', allImages.length);
    console.log('选中图片数量:', selectedImages.size);
};

// 手动去重功能
window.removeDuplicates = function () {
    console.log('=== 手动去重 ===');
    console.log('去重前图片数量:', allImages.length);

    const hasDuplicates = removeDuplicateImages();
    if (hasDuplicates) {
        applyFiltersAndSort();
        showNotification('已移除重复图片', 'success');
        console.log('去重后图片数量:', allImages.length);
    } else {
        showNotification('没有发现重复图片', 'info');
        console.log('没有重复图片');
    }
};

// 页面关闭前清理
window.addEventListener('beforeunload', () => {
    // 清理防抖定时器
    if (extractDebounceTimer) {
        clearTimeout(extractDebounceTimer);
    }
});
