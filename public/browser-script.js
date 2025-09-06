// Browser-in-Browser JavaScript
class ProxyBrowser {
  constructor() {
    this.tabs = [];
    this.activeTab = 0;
    this.history = {};
    this.maxTabs = 10;
    
    this.init();
  }
  
  init() {
    this.bindEvents();
    this.createInitialTab();
    this.loadTheme();
  }
  
  bindEvents() {
    // Tab events
    document.addEventListener('click', (e) => {
      if (e.target.closest('.tab-add')) {
        this.createNewTab();
      } else if (e.target.closest('.tab-close')) {
        e.stopPropagation();
        const tab = e.target.closest('.tab');
        const tabIndex = parseInt(tab.dataset.tab);
        this.closeTab(tabIndex);
      } else if (e.target.closest('.tab')) {
        const tab = e.target.closest('.tab');
        const tabIndex = parseInt(tab.dataset.tab);
        this.switchTab(tabIndex);
      }
    });
    
    // Navigation events
    document.querySelector('.back-btn').addEventListener('click', () => this.goBack());
    document.querySelector('.forward-btn').addEventListener('click', () => this.goForward());
    document.querySelector('.refresh-btn').addEventListener('click', () => this.refresh());
    document.querySelector('.home-btn').addEventListener('click', () => this.goHome());
    
    // Address bar events
    const urlInput = document.querySelector('.url-input');
    urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.navigate(urlInput.value);
      }
    });
    
    document.querySelector('.go-btn').addEventListener('click', () => {
      this.navigate(urlInput.value);
    });
    
    // Search events
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.navigate(searchInput.value);
        }
      });
      
      document.querySelector('.search-btn').addEventListener('click', () => {
        this.navigate(searchInput.value);
      });
    }
    
    // Quick links
    document.addEventListener('click', (e) => {
      if (e.target.closest('.quick-link')) {
        e.preventDefault();
        const url = e.target.closest('.quick-link').dataset.url;
        this.navigate(url);
      }
    });
    
    // History items
    document.addEventListener('click', (e) => {
      if (e.target.closest('.history-item')) {
        const url = e.target.closest('.history-item').dataset.url;
        this.navigate(url);
      }
    });
    
    // Menu events
    document.querySelector('.fullscreen-btn').addEventListener('click', () => this.toggleFullscreen());
    document.querySelector('.settings-btn').addEventListener('click', () => this.openSettings());
    document.querySelector('.more-btn').addEventListener('click', (e) => this.showContextMenu(e));
    
    // Context menu
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.context-menu')) {
        this.hideContextMenu();
      }
    });
    
    document.addEventListener('click', (e) => {
      if (e.target.closest('.menu-item')) {
        const action = e.target.closest('.menu-item').dataset.action;
        this.handleContextAction(action);
        this.hideContextMenu();
      }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 't':
            e.preventDefault();
            this.createNewTab();
            break;
          case 'w':
            e.preventDefault();
            this.closeTab(this.activeTab);
            break;
          case 'r':
            e.preventDefault();
            this.refresh();
            break;
          case 'l':
            e.preventDefault();
            document.querySelector('.url-input').select();
            break;
        }
      }
      
      if (e.key === 'F11') {
        e.preventDefault();
        this.toggleFullscreen();
      }
    });
    
    // Tab switching shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const tabIndex = parseInt(e.key) - 1;
        if (tabIndex < this.tabs.length) {
          this.switchTab(tabIndex);
        }
      }
    });
  }
  
  createInitialTab() {
    this.createNewTab('proxy://start', 'New Tab');
  }
  
  createNewTab(url = 'proxy://start', title = 'New Tab') {
    if (this.tabs.length >= this.maxTabs) {
      this.showNotification('Maximum number of tabs reached', 'warning');
      return;
    }
    
    const tabIndex = this.tabs.length;
    
    // Create tab data
    const tabData = {
      id: tabIndex,
      url: url,
      title: title,
      history: [url],
      historyIndex: 0,
      loading: false
    };
    
    this.tabs.push(tabData);
    
    // Create tab element
    const tabBar = document.querySelector('.tab-bar');
    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.dataset.tab = tabIndex;
    tabElement.innerHTML = `
      <span class="tab-title">${title}</span>
      <i class="fas fa-times tab-close"></i>
    `;
    
    const addButton = document.querySelector('.tab-add');
    tabBar.insertBefore(tabElement, addButton);
    
    // Create content element
    const contentArea = document.querySelector('.content-area');
    const contentElement = document.createElement('div');
    contentElement.className = 'tab-content';
    contentElement.dataset.tab = tabIndex;
    contentArea.appendChild(contentElement);
    
    // Switch to new tab
    this.switchTab(tabIndex);
    
    // Load content
    this.loadTabContent(tabIndex, url);
  }
  
  closeTab(tabIndex) {
    if (this.tabs.length <= 1) {
      this.showNotification('Cannot close the last tab', 'warning');
      return;
    }
    
    // Remove tab element
    const tabElement = document.querySelector(`[data-tab="${tabIndex}"].tab`);
    const contentElement = document.querySelector(`[data-tab="${tabIndex}"].tab-content`);
    
    if (tabElement) tabElement.remove();
    if (contentElement) contentElement.remove();
    
    // Remove from tabs array
    this.tabs.splice(tabIndex, 1);
    
    // Update tab indices
    this.updateTabIndices();
    
    // Switch to adjacent tab
    if (this.activeTab >= this.tabs.length) {
      this.activeTab = this.tabs.length - 1;
    }
    
    this.switchTab(this.activeTab);
  }
  
  switchTab(tabIndex) {
    if (tabIndex < 0 || tabIndex >= this.tabs.length) return;
    
    // Deactivate current tab
    document.querySelectorAll('.tab.active').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content.active').forEach(content => content.classList.remove('active'));
    
    // Activate new tab
    const tabElement = document.querySelector(`[data-tab="${tabIndex}"].tab`);
    const contentElement = document.querySelector(`[data-tab="${tabIndex}"].tab-content`);
    
    if (tabElement && contentElement) {
      tabElement.classList.add('active');
      contentElement.classList.add('active');
      
      this.activeTab = tabIndex;
      const tab = this.tabs[tabIndex];
      
      // Update URL bar
      document.querySelector('.url-input').value = tab.url;
      
      // Update navigation buttons
      this.updateNavigationButtons();
      
      // Update security indicator
      this.updateSecurityIndicator(tab.url);
    }
  }
  
  navigate(input) {
    if (!input.trim()) return;
    
    let url = input.trim();
    
    // Check if it's a search query or URL
    if (!this.isValidUrl(url)) {
      // Convert to search
      url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    } else if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('proxy://')) {
      url = 'https://' + url;
    }
    
    this.loadTabContent(this.activeTab, url);
  }
  
  loadTabContent(tabIndex, url) {
    const tab = this.tabs[tabIndex];
    const contentElement = document.querySelector(`[data-tab="${tabIndex}"].tab-content`);
    const tabElement = document.querySelector(`[data-tab="${tabIndex}"].tab`);
    
    if (!tab || !contentElement) return;
    
    // Show loading
    this.setTabLoading(tabIndex, true);
    
    // Update tab data
    tab.url = url;
    
    // Add to history if it's a new URL
    if (tab.history[tab.historyIndex] !== url) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(url);
      tab.historyIndex = tab.history.length - 1;
    }
    
    // Update URL bar if this is the active tab
    if (tabIndex === this.activeTab) {
      document.querySelector('.url-input').value = url;
      this.updateNavigationButtons();
      this.updateSecurityIndicator(url);
    }
    
    // Handle special URLs
    if (url === 'proxy://start' || url === 'proxy://home') {
      this.loadStartPage(contentElement, tabElement);
      this.setTabLoading(tabIndex, false);
      return;
    }
    
    if (url === 'proxy://settings') {
      this.loadSettingsPage(contentElement, tabElement);
      this.setTabLoading(tabIndex, false);
      return;
    }
    
    if (url === 'proxy://history') {
      this.loadHistoryPage(contentElement, tabElement);
      this.setTabLoading(tabIndex, false);
      return;
    }
    
    // Load external content through proxy
    this.loadProxiedContent(url, contentElement, tabElement, tabIndex);
  }
  
  loadProxiedContent(url, contentElement, tabElement, tabIndex) {
    const proxyUrl = `/proxy?target=${encodeURIComponent(url)}`;
    
    // Create iframe for proxied content
    contentElement.innerHTML = `
      <iframe src="${proxyUrl}" class="content-frame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox">
        <p>Your browser does not support iframes.</p>
      </iframe>
    `;
    
    const iframe = contentElement.querySelector('.content-frame');
    
    iframe.onload = () => {
      this.setTabLoading(tabIndex, false);
      
      try {
        // Try to get the title from the iframe
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const title = iframeDoc.title || new URL(url).hostname;
        this.updateTabTitle(tabIndex, title);
      } catch (e) {
        // Cross-origin restrictions, use hostname as title
        const title = new URL(url).hostname;
        this.updateTabTitle(tabIndex, title);
      }
    };
    
    iframe.onerror = () => {
      this.setTabLoading(tabIndex, false);
      this.showErrorPage(contentElement, 'Failed to load the requested page');
    };
  }
  
  loadStartPage(contentElement, tabElement) {
    // The start page is already in the HTML, just need to show it
    if (contentElement.querySelector('.start-page')) {
      this.updateTabTitle(this.activeTab, 'New Tab');
      return;
    }
    
    // If start page isn't there, redirect to home
    window.location.href = '/browser';
  }
  
  loadSettingsPage(contentElement, tabElement) {
    contentElement.innerHTML = `
      <div class="settings-page">
        <div class="settings-header">
          <h1>⚙️ Settings</h1>
          <p>Configure your proxy browser</p>
        </div>
        
        <div class="settings-content">
          <div class="setting-section">
            <h3>Appearance</h3>
            <div class="setting-item">
              <label>Theme</label>
              <select id="theme-selector">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="auto">Auto</option>
              </select>
            </div>
          </div>
          
          <div class="setting-section">
            <h3>Privacy</h3>
            <div class="setting-item">
              <label>
                <input type="checkbox" id="clear-on-exit"> Clear history on exit
              </label>
            </div>
            <div class="setting-item">
              <button class="btn secondary" onclick="browserInstance.clearHistory()">Clear All History</button>
            </div>
          </div>
          
          <div class="setting-section">
            <h3>Advanced</h3>
            <div class="setting-item">
              <label>
                <input type="checkbox" id="block-ads"> Block advertisements
              </label>
            </div>
            <div class="setting-item">
              <label>
                <input type="checkbox" id="force-https"> Force HTTPS
              </label>
            </div>
          </div>
        </div>
      </div>
    `;
    
    this.updateTabTitle(this.activeTab, 'Settings');
    this.bindSettingsEvents();
  }
  
  loadHistoryPage(contentElement, tabElement) {
    // Fetch history from server
    fetch('/api/history?limit=100')
      .then(response => response.json())
      .then(history => {
        contentElement.innerHTML = `
          <div class="history-page">
            <div class="history-header">
              <h1>📚 History</h1>
              <p>Your browsing history</p>
              <button class="btn secondary" onclick="browserInstance.clearHistory()">Clear All</button>
            </div>
            
            <div class="history-content">
              ${history.length > 0 ? history.map(item => `
                <div class="history-entry" data-url="${item.url}">
                  <div class="history-favicon">
                    <i class="fas fa-globe"></i>
                  </div>
                  <div class="history-details">
                    <div class="history-title">${item.target_host}</div>
                    <div class="history-url">${item.url}</div>
                    <div class="history-time">${new Date(item.created_at).toLocaleString()}</div>
                  </div>
                  <div class="history-actions">
                    <button class="btn-icon" onclick="browserInstance.navigate('${item.url}')" title="Visit">
                      <i class="fas fa-external-link-alt"></i>
                    </button>
                  </div>
                </div>
              `).join('') : '<p class="no-history">No history found</p>'}
            </div>
          </div>
        `;
        
        this.updateTabTitle(this.activeTab, 'History');
      })
      .catch(() => {
        this.showErrorPage(contentElement, 'Failed to load history');
      });
  }
  
  showErrorPage(contentElement, message) {
    contentElement.innerHTML = `
      <div class="error-page">
        <div class="error-content">
          <i class="fas fa-exclamation-triangle"></i>
          <h2>Oops! Something went wrong</h2>
          <p>${message}</p>
          <button class="btn primary" onclick="browserInstance.refresh()">Try Again</button>
          <button class="btn secondary" onclick="browserInstance.goHome()">Go Home</button>
        </div>
      </div>
    `;
  }
  
  updateTabTitle(tabIndex, title) {
    const tab = this.tabs[tabIndex];
    const tabElement = document.querySelector(`[data-tab="${tabIndex}"].tab`);
    
    if (tab && tabElement) {
      tab.title = title;
      tabElement.querySelector('.tab-title').textContent = title;
    }
  }
  
  setTabLoading(tabIndex, loading) {
    const tab = this.tabs[tabIndex];
    const tabElement = document.querySelector(`[data-tab="${tabIndex}"].tab`);
    
    if (tab && tabElement) {
      tab.loading = loading;
      
      if (loading) {
        tabElement.classList.add('loading');
        if (tabIndex === this.activeTab) {
          this.showLoading();
        }
      } else {
        tabElement.classList.remove('loading');
        if (tabIndex === this.activeTab) {
          this.hideLoading();
        }
      }
    }
  }
  
  updateNavigationButtons() {
    const tab = this.tabs[this.activeTab];
    if (!tab) return;
    
    const backBtn = document.querySelector('.back-btn');
    const forwardBtn = document.querySelector('.forward-btn');
    
    backBtn.disabled = tab.historyIndex <= 0;
    forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
  }
  
  updateSecurityIndicator(url) {
    const indicator = document.querySelector('.security-indicator i');
    
    if (url.startsWith('https://') || url.startsWith('proxy://')) {
      indicator.className = 'fas fa-lock';
      indicator.style.color = 'var(--success-color)';
    } else {
      indicator.className = 'fas fa-unlock';
      indicator.style.color = 'var(--warning-color)';
    }
  }
  
  updateTabIndices() {
    document.querySelectorAll('.tab').forEach((tab, index) => {
      tab.dataset.tab = index;
    });
    
    document.querySelectorAll('.tab-content').forEach((content, index) => {
      content.dataset.tab = index;
    });
    
    this.tabs.forEach((tab, index) => {
      tab.id = index;
    });
  }
  
  goBack() {
    const tab = this.tabs[this.activeTab];
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      const url = tab.history[tab.historyIndex];
      this.loadTabContent(this.activeTab, url);
    }
  }
  
  goForward() {
    const tab = this.tabs[this.activeTab];
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      const url = tab.history[tab.historyIndex];
      this.loadTabContent(this.activeTab, url);
    }
  }
  
  refresh() {
    const tab = this.tabs[this.activeTab];
    if (tab) {
      this.loadTabContent(this.activeTab, tab.url);
    }
  }
  
  goHome() {
    this.loadTabContent(this.activeTab, 'proxy://start');
  }
  
  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }
  
  openSettings() {
    this.loadTabContent(this.activeTab, 'proxy://settings');
  }
  
  showContextMenu(e) {
    e.preventDefault();
    const contextMenu = document.querySelector('.context-menu');
    contextMenu.style.left = e.pageX + 'px';
    contextMenu.style.top = e.pageY + 'px';
    contextMenu.classList.remove('hidden');
  }
  
  hideContextMenu() {
    document.querySelector('.context-menu').classList.add('hidden');
  }
  
  handleContextAction(action) {
    switch (action) {
      case 'back':
        this.goBack();
        break;
      case 'forward':
        this.goForward();
        break;
      case 'refresh':
        this.refresh();
        break;
      case 'home':
        this.goHome();
        break;
      case 'history':
        this.loadTabContent(this.activeTab, 'proxy://history');
        break;
      case 'settings':
        this.openSettings();
        break;
    }
  }
  
  showLoading() {
    document.querySelector('.loading-overlay').classList.remove('hidden');
  }
  
  hideLoading() {
    document.querySelector('.loading-overlay').classList.add('hidden');
  }
  
  showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <i class="fas ${type === 'success' ? 'fa-check' : type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle'}"></i>
      <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
      notification.remove();
    }, 3000);
  }
  
  clearHistory() {
    fetch('/api/history', { method: 'DELETE' })
      .then(() => {
        this.showNotification('History cleared successfully', 'success');
      })
      .catch(() => {
        this.showNotification('Failed to clear history', 'error');
      });
  }
  
  bindSettingsEvents() {
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) {
      themeSelector.value = localStorage.getItem('theme') || 'dark';
      themeSelector.addEventListener('change', (e) => {
        this.setTheme(e.target.value);
      });
    }
  }
  
  loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    this.setTheme(savedTheme);
  }
  
  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }
  
  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }
}

// Initialize the browser when DOM is loaded
let browserInstance;
document.addEventListener('DOMContentLoaded', () => {
  browserInstance = new ProxyBrowser();
});

// Export for global access
window.browserInstance = browserInstance;
