let allImages = [];
let filteredImages = [];
let selectedImages = new Set();
let currentTabId = null;
let autoExtractEnabled = false;
let autoExtractInterval = null;
let lastImageCount = 0;
let lastClickedIndex = -1; // 用于Shift范围选择
let activeSizeFilters = new Set(); // 当前激活的尺寸筛选（支持多选）

// DOM元素
const extractBtn = document.getElementById('extractBtn');
const autoExtractToggle = document.getElementById('autoExtractToggle');
const tabSelect = document.getElementById('tabSelect');
const refreshTabsBtn = document.getElementById('refreshTabsBtn');
const sortSelect = document.getElementById('sortSelect');
const filterSelect = document.getElementById('filterSelect');
const minWidthInput = document.getElementById('minWidth');
const minHeightInput = document.getElementById('minHeight');
const applyFilterBtn = document.getElementById('applyFilter');
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

// 初始化
async function init() {
    loadSizeFilterState(); // 加载保存的尺寸筛选状态
    await loadAvailableTabs();
    setupEventListeners();
}

// 设置事件监听
function setupEventListeners() {
    extractBtn.addEventListener('click', extractImagesFromCurrentTab);
    autoExtractToggle.addEventListener('change', toggleAutoExtract);
    refreshTabsBtn.addEventListener('click', loadAvailableTabs);
    sortSelect.addEventListener('change', applyFiltersAndSort);
    filterSelect.addEventListener('change', applyFiltersAndSort);
    applyFilterBtn.addEventListener('click', applyFiltersAndSort);
    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);
    invertSelectionBtn.addEventListener('click', invertSelection);
    downloadSelectedBtn.addEventListener('click', downloadSelected);
    clearBtn.addEventListener('click', clearAll);
    clearSizeFilterBtn.addEventListener('click', clearSizeFilter);
    selectAllSizesBtn.addEventListener('click', selectAllSizes);
    deselectAllSizesBtn.addEventListener('click', deselectAllSizes);

    minWidthInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') applyFiltersAndSort();
    });

    minHeightInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') applyFiltersAndSort();
    });
}

// 切换自动提取
function toggleAutoExtract() {
    autoExtractEnabled = autoExtractToggle.checked;

    if (autoExtractEnabled) {
        const selectedTabId = parseInt(tabSelect.value);
        if (!selectedTabId) {
            showNotification('请先选择要监控的页面', 'info');
            autoExtractToggle.checked = false;
            autoExtractEnabled = false;
            return;
        }

        // 先提取一次
        extractImagesFromCurrentTab();

        // 启动自动提取
        startAutoExtract();
        showNotification('已开启自动持续提取，将每5秒检测新图片', 'success');
    } else {
        stopAutoExtract();
        showNotification('已关闭自动提取', 'info');
    }
}

// 启动自动提取
function startAutoExtract() {
    if (autoExtractInterval) {
        clearInterval(autoExtractInterval);
    }

    autoExtractInterval = setInterval(async () => {
        if (!autoExtractEnabled) {
            stopAutoExtract();
            return;
        }

        const selectedTabId = parseInt(tabSelect.value);
        if (!selectedTabId) {
            return;
        }

        try {
            // 静默提取（不显示加载动画）
            const results = await chrome.scripting.executeScript({
                target: { tabId: selectedTabId },
                function: extractImagesFromPage
            });

            const newImages = results[0].result || [];
            await loadImageDimensions(newImages);

            // 检查是否有新图片
            const existingUrls = new Set(allImages.map(img => img.url));
            let newCount = 0;

            newImages.forEach(img => {
                if (!existingUrls.has(img.url)) {
                    allImages.push(img);
                    newCount++;
                }
            });

            if (newCount > 0) {
                applyFiltersAndSort();
                showNotification(`发现 ${newCount} 张新图片！总共 ${allImages.length} 张`, 'success');
            }
        } catch (error) {
            console.error('自动提取失败:', error);
        }
    }, 5000); // 每5秒检测一次
}

// 停止自动提取
function stopAutoExtract() {
    if (autoExtractInterval) {
        clearInterval(autoExtractInterval);
        autoExtractInterval = null;
    }
}

// 加载可用标签页
async function loadAvailableTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        tabSelect.innerHTML = '';

        // 过滤掉chrome://等特殊页面
        const validTabs = tabs.filter(tab =>
            !tab.url.startsWith('chrome://') &&
            !tab.url.startsWith('chrome-extension://') &&
            !tab.url.startsWith('edge://') &&
            !tab.url.startsWith('about:')
        );

        if (validTabs.length === 0) {
            tabSelect.innerHTML = '<option value="">没有可提取的页面</option>';
            return;
        }

        validTabs.forEach(tab => {
            const option = document.createElement('option');
            option.value = tab.id;
            option.textContent = tab.title || tab.url;
            if (tab.active) {
                option.selected = true;
                currentTabId = tab.id;
            }
            tabSelect.appendChild(option);
        });
    } catch (error) {
        console.error('加载标签页失败:', error);
    }
}

// 从当前选中的标签页提取图片
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

        // 保存当前选中的图片索引（基于URL）
        const selectedUrls = new Set();
        selectedImages.forEach(index => {
            if (filteredImages[index]) {
                selectedUrls.add(filteredImages[index].url);
            }
        });

        // 注入并执行内容脚本
        const results = await chrome.scripting.executeScript({
            target: { tabId: selectedTabId },
            function: extractImagesFromPage
        });

        const newImages = results[0].result || [];

        // 等待图片加载完成后获取尺寸信息
        await loadImageDimensions(newImages);

        // 添加到现有图片列表（不重复）
        const existingUrls = new Set(allImages.map(img => img.url));
        newImages.forEach(img => {
            if (!existingUrls.has(img.url)) {
                allImages.push(img);
            }
        });

        // 应用筛选和排序
        applyFiltersAndSort();

        // 恢复之前选中的图片
        selectedImages.clear();
        filteredImages.forEach((img, index) => {
            if (selectedUrls.has(img.url)) {
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
        console.error('提取图片失败:', error);
        loadingIndicator.style.display = 'none';
        showNotification('提取失败，请确保页面已完全加载', 'error');
    }
}

// 在页面中执行的函数（提取图片）
function extractImagesFromPage() {
    const images = [];
    const seenUrls = new Set();

    // 1. 提取 <img> 标签
    document.querySelectorAll('img').forEach(img => {
        let src = img.currentSrc || img.src;
        if (src && !seenUrls.has(src)) {
            seenUrls.add(src);

            // 尝试获取更准确的尺寸信息
            let width = img.naturalWidth || img.width || 0;
            let height = img.naturalHeight || img.height || 0;

            // 如果尺寸为0，尝试从属性中获取
            if (width === 0 && height === 0) {
                width = parseInt(img.getAttribute('width')) || 0;
                height = parseInt(img.getAttribute('height')) || 0;
            }

            images.push({
                url: src,
                type: src.startsWith('data:') ? 'base64' : 'img',
                width: width,
                height: height,
                alt: img.alt || ''
            });
        }
    });

    // 2. 提取背景图片
    const allElements = document.querySelectorAll('*');
    allElements.forEach(element => {
        const style = window.getComputedStyle(element);
        const bgImage = style.backgroundImage;

        if (bgImage && bgImage !== 'none') {
            const matches = bgImage.match(/url\(["']?([^"']*)["']?\)/g);
            if (matches) {
                matches.forEach(match => {
                    let url = match.replace(/url\(["']?/, '').replace(/["']?\)/, '');

                    if (!url.startsWith('http') && !url.startsWith('data:')) {
                        try {
                            url = new URL(url, window.location.href).href;
                        } catch (e) {
                            console.warn('无法解析背景图片URL:', url);
                            return;
                        }
                    }

                    if (!seenUrls.has(url)) {
                        seenUrls.add(url);
                        images.push({
                            url: url,
                            type: url.startsWith('data:') ? 'base64' : 'background',
                            width: 0,
                            height: 0,
                            alt: ''
                        });
                    }
                });
            }
        }
    });

    // 3. 提取 SVG 图片
    document.querySelectorAll('svg').forEach(svg => {
        try {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svg);
            const base64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));

            if (!seenUrls.has(base64)) {
                seenUrls.add(base64);
                images.push({
                    url: base64,
                    type: 'base64',
                    width: svg.width.baseVal.value || 0,
                    height: svg.height.baseVal.value || 0,
                    alt: 'SVG图片'
                });
            }
        } catch (e) {
            console.error('SVG提取失败:', e);
        }
    });

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
                console.warn('AVIF/WebP图片加载失败:', img.url, error);
                img.width = 0;
                img.height = 0;
            }
            return;
        }

        // 对于其他格式，使用原有逻辑但增加重试
        return new Promise((resolve) => {
            const image = new Image();

            const timeout = setTimeout(() => {
                console.warn('图片加载超时:', img.url);
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
                console.warn('图片加载失败:', img.url, error);
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

// 应用筛选和排序
function applyFiltersAndSort() {
    const minWidth = parseInt(minWidthInput.value) || 0;
    const minHeight = parseInt(minHeightInput.value) || 0;
    const filterType = filterSelect.value;
    const sortType = sortSelect.value;

    // 筛选
    filteredImages = allImages.filter(img => {
        if (img.width < minWidth || img.height < minHeight) {
            return false;
        }

        if (filterType !== 'all' && img.type !== filterType) {
            return false;
        }

        // 如果有激活的尺寸筛选，应用它（支持多选）
        // 注意：当activeSizeFilters.size > 0时，只显示选中的尺寸
        // 当activeSizeFilters.size === 0时，显示所有图片（相当于没有尺寸筛选）
        if (activeSizeFilters.size > 0) {
            const imgSize = `${img.width}×${img.height}`;
            const isInFilter = activeSizeFilters.has(imgSize);
            if (!isInFilter) {
                return false;
            }
        }

        return true;
    });

    // 排序
    if (sortType === 'size-desc') {
        filteredImages.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    } else if (sortType === 'size-asc') {
        filteredImages.sort((a, b) => (a.width * a.height) - (b.width * b.height));
    } else if (sortType === 'width-desc') {
        filteredImages.sort((a, b) => b.width - a.width);
    } else if (sortType === 'height-desc') {
        filteredImages.sort((a, b) => b.height - a.height);
    }

    // 生成尺寸标签
    generateSizeTags();

    renderImages();
}

// 生成尺寸标签
function generateSizeTags() {
    // 统计每个尺寸的数量
    const sizeCount = {};

    allImages.forEach(img => {
        // 跳过无效尺寸
        if (img.width === 0 || img.height === 0) return;

        const size = `${img.width}×${img.height}`;
        sizeCount[size] = (sizeCount[size] || 0) + 1;
    });

    // 按面积(宽×高)从大到小排序；同面积按数量从多到少
    const sortedSizes = Object.entries(sizeCount)
        .map(([size, count]) => {
            const [wStr, hStr] = size.split('×');
            const w = parseInt(wStr, 10) || 0;
            const h = parseInt(hStr, 10) || 0;
            return { size, count, area: w * h };
        })
        .sort((a, b) => {
            if (b.area !== a.area) return b.area - a.area; // 面积优先
            if (b.count !== a.count) return b.count - a.count; // 数量次之
            return 0;
        })
        .slice(0, 20) // 最多显示20个尺寸
        .map(item => [item.size, item.count]);

    // 清空现有标签
    sizeTags.innerHTML = '';

    if (sortedSizes.length === 0) {
        sizeTagsContainer.style.display = 'none';
        return;
    }

    // 显示容器
    sizeTagsContainer.style.display = 'block';

    // 不默认全选，让用户主动选择尺寸进行筛选
    // 当activeSizeFilters.size === 0时，显示所有图片
    // 当activeSizeFilters.size > 0时，只显示选中的尺寸

    // 生成标签
    sortedSizes.forEach(([size, count]) => {
        const tag = document.createElement('button');
        tag.className = 'size-tag';
        tag.dataset.size = size;

        // 根据当前筛选状态设置标签状态
        if (activeSizeFilters.has(size)) {
            tag.classList.add('active');
        }

        tag.innerHTML = `
      <span>${size}</span>
      <span class="count">${count}</span>
    `;
        tag.addEventListener('click', () => toggleSizeFilter(size));
        sizeTags.appendChild(tag);
    });

    // 更新清除按钮显示状态
    updateSizeFilterButtons();
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

    // 保存选择状态
    saveSizeFilterState();
    updateSizeFilterButtons();

    // 调试信息
    console.log('尺寸筛选状态:', Array.from(activeSizeFilters));
    console.log('当前筛选的尺寸数量:', activeSizeFilters.size);

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
            console.log('加载保存的尺寸筛选状态:', Array.from(activeSizeFilters));
        } else {
            console.log('没有保存的尺寸筛选状态，将使用默认全选');
        }
    } catch (error) {
        console.error('加载尺寸筛选状态失败:', error);
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

    saveSizeFilterState();
    updateSizeFilterButtons();
    applyFiltersAndSort();
    showNotification(`已选中全部 ${activeSizeFilters.size} 个尺寸`, 'success');
}

// 全不选（清除所有尺寸筛选）
function deselectAllSizes() {
    activeSizeFilters.clear();

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
    saveSizeFilterState();
    updateSizeFilterButtons();
    applyFiltersAndSort();
    showNotification('已清除所有尺寸筛选', 'info');
}

// 渲染图片网格
function renderImages() {
    imageGrid.innerHTML = '';

    // 清理不存在的选中项
    const validIndices = new Set(filteredImages.map((_, i) => i));
    selectedImages = new Set([...selectedImages].filter(i => validIndices.has(i)));

    if (filteredImages.length === 0 && allImages.length > 0) {
        imageGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #6c757d;">没有符合筛选条件的图片</div>';
        updateStats();
        return;
    }

    filteredImages.forEach((img, index) => {
        const item = document.createElement('div');
        item.className = 'image-item';
        item.dataset.index = index;

        const typeClass = `type-${img.type}`;
        const typeName = {
            'img': 'IMG',
            'background': '背景',
            'base64': 'Base64'
        }[img.type];

        item.innerHTML = `
      <div class="checkbox-overlay"></div>
      <button class="download-btn" title="下载">💾</button>
      <div class="image-wrapper">
        <img src="${img.url}" alt="${img.alt || '图片'}" loading="lazy">
      </div>
      <div class="image-info">
        <span class="image-type ${typeClass}">${typeName}</span>
        <div>尺寸: ${img.width} × ${img.height}</div>
        <div>大小: ${formatFileSize(img.url.length)}</div>
      </div>
    `;

        // 点击选择/取消选择（支持Ctrl和Shift）
        item.addEventListener('click', (e) => {
            if (e.target.closest('.download-btn')) {
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

// 下载单张图片
async function downloadImage(img, index) {
    try {
        const filename = `image_${Date.now()}_${index}.${getImageExtension(img.url)}`;

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
        console.error('下载失败:', error);
        showNotification('下载失败，请重试', 'error');
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
            console.warn(`图片加载失败 (尝试 ${attempt}/${maxRetries}):`, url, error);
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

    let count = 0;
    for (const index of selectedImages) {
        const img = filteredImages[index];
        await downloadImage(img, index);
        count++;

        downloadSelectedBtn.textContent = `下载中... (${count}/${selectedImages.size})`;

        // 添加延迟避免下载过快
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    downloadSelectedBtn.textContent = originalText;
    downloadSelectedBtn.disabled = false;

    showNotification(`成功下载 ${count} 张图片！`, 'success');
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
function clearAll() {
    if (allImages.length === 0) return;

    if (confirm(`确定要清空所有 ${allImages.length} 张图片吗？`)) {
        // 停止自动提取
        if (autoExtractEnabled) {
            autoExtractToggle.checked = false;
            autoExtractEnabled = false;
            stopAutoExtract();
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

// 添加测试函数到全局作用域，方便调试
window.testSizeFilter = testSizeFilter;

// 页面关闭前清理
window.addEventListener('beforeunload', () => {
    if (autoExtractInterval) {
        clearInterval(autoExtractInterval);
    }
});
