class PhotoRestorer {
    constructor() {
        this.initializeElements();
        this.setupEventListeners();
        this.currentImage = null;
        this.restoredImageData = null;
        this._recentUrls = new Set();
        
        // Backend proxy for Gemini (server handles API key)
        this.serverEndpoint = '/api/analyze';
        
        // Photo restoration prompt (original, with colorization guidance)
        this.restorationPrompt = `**Primary Goal:** To breathe new life into this historical photograph through faithful restoration, comprehensive and photorealistic colorization, and careful upscaling. The objective is to create a final image that looks like a well-preserved, authentic color photograph from the historical era, representing the moment as it truly appeared.

**Core Principles for a True-to-Life Result:**
- **Photorealistic Authenticity:** The highest priority is making the entire scene—subjects, environment, and objects—look completely real and true-to-life. The image should be a faithful window into the past.
- **Preserve Historical Character:** The final result should embrace and retain the unique characteristics of the original photographic technology. The goal is enhancement, not modernization.

**Detailed Instructions for Enhancement:**
1. **Comprehensive and Realistic Colorization:**
   - **Colorize the Entire Scene:** Apply a full spectrum of rich, natural, and historically accurate colors to every part of the image. This includes the main subjects and the complete environment.
   - **Lifelike Environment:** Render the environment with vibrant, realistic colors. Grass should be a natural green, skies should be blue, and the ground (dirt, stone, etc.) should have its authentic, rich coloration.
   - **Natural Skin Tones:** Render all skin tones with a healthy, lifelike appearance, ensuring they are fully colored and show natural variations.
   - **Cohesive Color Harmony:** Ensure all colors in the scene work together harmoniously, creating a believable and unified image.

2. **Faithful Restoration:**
   - Gently repair physical imperfections such as scratches, dust, and fading.
   - Enhance the clarity of existing details to bring the original image into sharper focus.
   - Faithfully reproduce the original lighting, shadows, and composition of the photograph.

3. **Authentic Upscaling:**
   - Increase the image resolution and clarity.
   - Retain the authentic and desirable characteristics of the original photo, including natural film grain, the original soft focus, and other qualities inherent to cameras from that period.

**Desired Final Qualities:**
- **A Genuine Photograph, Not a Cinematic Still:** The image should look like an authentic historical photo. Faithfully reproduce the original lighting without adding dramatic or artificial effects.
- **Rich and Full Color:** The image should be fully and vibrantly colored in a way that is realistic for the time period.

ANALYZE THIS HISTORICAL PHOTOGRAPH AND PROVIDE DETAILED RESTORATION INSTRUCTIONS including:
1. What era/time period this appears to be from
2. What colors should be applied to different elements (clothing, background, objects, skin tones)
3. What damage needs to be repaired
4. What specific historical context should guide the colorization
5. Specific RGB color values for major elements when possible`;
    }

    async getStripe() {
        try {
            if (this._stripe) return this._stripe;
            if (typeof Stripe !== 'function') return null;
            const r = await fetch('/api/config', { credentials: 'include' });
            const j = await r.json().catch(() => ({}));
            const pk = j?.stripePublishableKey;
            if (!pk) return null;
            this._stripe = Stripe(pk);
            return this._stripe;
        } catch {
            return null;
        }
    }

    initializeElements() {
        this.uploadArea = document.getElementById('uploadArea');
        this.fileInput = document.getElementById('fileInput');
        this.uploadBtn = document.getElementById('uploadBtn');
        this.uploadHeading = document.getElementById('uploadHeading');
        this.creditInfo = document.getElementById('creditInfo');
        this.creditInfoTop = document.getElementById('creditInfoTop');
        this.testBadge = document.getElementById('testBadge');
        this.buyBtn = document.getElementById('buyBtn');
        this.buyBtnTop = document.getElementById('buyBtnTop');
        // Drawer elements
        this.buyDrawer = document.getElementById('buyDrawer');
        this.drawerOverlay = document.getElementById('drawerOverlay');
        this.drawerClose = document.getElementById('drawerClose');
        this.processingSection = document.getElementById('processingSection');
        this.resultsSection = document.getElementById('resultsSection');
        this.originalImage = document.getElementById('originalImage');
        this.restoredImage = document.getElementById('restoredImage');
        this.originalFrame = this.originalImage?.closest('.image-frame');
        this.restoredFrame = this.restoredImage?.closest('.image-frame');
        this.downloadBtn = document.getElementById('downloadBtn');
        this.newPhotoBtn = document.getElementById('newPhotoBtn');
        this.examplesGrid = document.getElementById('examplesGrid');
        // Lightbox elements
        this.lbOverlay = document.getElementById('imageLightboxOverlay');
        this.lbModal = document.getElementById('imageLightbox');
        this.lbImage = document.getElementById('lbImage');
        this.lbClose = document.getElementById('lbClose');
        this.lbLabel = document.getElementById('lbLabel');
        this.lbDownload = document.getElementById('lbDownload');
        // Recent
        this.recentSection = document.getElementById('recentSection');
        this.recentGrid = document.getElementById('recentGrid');
        this.clearRecentBtn = document.getElementById('clearRecentBtn');
        this.recentPrev = document.getElementById('recentPrev');
        this.recentNext = document.getElementById('recentNext');
    }

    setupEventListeners() {
        // Upload area click
        this.uploadArea.addEventListener('click', () => {
            this.fileInput.click();
        });

        // Upload button click
        this.uploadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.fileInput.click();
        });

        // File input change
        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleFileSelection(e.target.files[0]);
            }
        });

        // Drag and drop
        this.uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.uploadArea.classList.add('drag-over');
        });

        this.uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            this.uploadArea.classList.remove('drag-over');
        });

        this.uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            this.uploadArea.classList.remove('drag-over');
            
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) {
                this.handleFileSelection(files[0]);
            }
        });

        // Download button
        this.downloadBtn.addEventListener('click', () => {
            this.downloadRestoredImage();
        });

        // New photo button
        this.newPhotoBtn.addEventListener('click', () => {
            this.resetInterface();
        });

        // Buy credits opens drawer
        if (this.buyBtn) {
            this.buyBtn.addEventListener('click', () => this.openDrawer());
        }
        if (this.buyBtnTop) {
            this.buyBtnTop.addEventListener('click', () => this.openDrawer());
        }
        if (this.drawerOverlay) {
            this.drawerOverlay.addEventListener('click', () => this.closeDrawer());
        }
        if (this.drawerClose) {
            this.drawerClose.addEventListener('click', () => this.closeDrawer());
        }
        // Option buttons inside drawer
        if (this.buyDrawer) {
            this.buyDrawer.querySelectorAll('.option').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const credits = parseInt(btn.getAttribute('data-credits'), 10);
                    if (!Number.isFinite(credits)) return;
                    try {
                        const r = await fetch('/api/buy-credits', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({ credits })
                        });
                        const j = await r.json().catch(() => ({}));
                        if (!r.ok) throw new Error(j.error || 'Failed to start checkout');
                        const stripe = await this.getStripe();
                        if (stripe && j.id) {
                            const { error } = await stripe.redirectToCheckout({ sessionId: j.id });
                            if (error) throw error;
                        } else if (j.url) {
                            window.location.href = j.url; // fallback without popup
                        } else {
                            throw new Error('Checkout session missing id/url');
                        }
                    } catch (e) {
                        alert('Unable to start checkout: ' + (e.message || e));
                    }
                });
            });
        }

        // Lightbox: click images to expand
        if (this.restoredImage) {
            this.restoredImage.setAttribute('tabindex', '0');
            this.restoredImage.setAttribute('role', 'button');
            this.restoredImage.setAttribute('aria-label', 'Expand restored image');
            this.restoredImage.addEventListener('click', () => {
                if (!this.restoredImageData?.url) return;
                const alt = `Expanded view of ${this.currentImage?.file?.name || 'restored image'}`;
                this.openLightbox(this.restoredImageData.url, alt, 'restored');
            });
            this.restoredImage.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (this.restoredImageData?.url) {
                        const alt = `Expanded view of ${this.currentImage?.file?.name || 'restored image'}`;
                        this.openLightbox(this.restoredImageData.url, alt, 'restored');
                    }
                }
            });
        }
        if (this.originalImage) {
            this.originalImage.setAttribute('tabindex', '0');
            this.originalImage.setAttribute('role', 'button');
            this.originalImage.setAttribute('aria-label', 'Expand original image');
            this.originalImage.addEventListener('click', () => {
                if (!this.currentImage?.dataUrl) return;
                const alt = `Expanded view of ${this.currentImage?.file?.name || 'original image'}`;
                this.openLightbox(this.currentImage.dataUrl, alt, 'original');
            });
            this.originalImage.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (this.currentImage?.dataUrl) {
                        const alt = `Expanded view of ${this.currentImage?.file?.name || 'original image'}`;
                        this.openLightbox(this.currentImage.dataUrl, alt, 'original');
                    }
                }
            });
        }
        // Magnifier affordance on frames
        this.originalFrame?.classList.add('zoomable');
        this.restoredFrame?.classList.add('zoomable');
        // Lightbox actions
        if (this.lbOverlay) this.lbOverlay.addEventListener('click', () => this.closeLightbox());
        if (this.lbClose) this.lbClose.addEventListener('click', () => this.closeLightbox());
        if (this.lbDownload) this.lbDownload.addEventListener('click', () => this.downloadLightboxImage());

        // Recent actions
        if (this.clearRecentBtn) {
            this.clearRecentBtn.addEventListener('click', async () => {
                if (!confirm('Clear recent restores from this device?')) return;
                await this.clearRecentCache();
                await this.loadRecent();
            });
        }
        if (this.recentPrev) this.recentPrev.addEventListener('click', () => this.scrollRecent(-1));
        if (this.recentNext) this.recentNext.addEventListener('click', () => this.scrollRecent(1));
        if (this.recentGrid) this.recentGrid.addEventListener('scroll', () => this.updateRecentArrows());
    }

    scrollRecent(dir) {
        if (!this.recentGrid) return;
        const first = this.recentGrid.querySelector('.recent-card');
        const rect = first ? first.getBoundingClientRect() : { width: 320 };
        const styles = getComputedStyle(this.recentGrid);
        const gap = parseInt(styles.columnGap || styles.gap || '0', 10) || 0;
        const delta = dir * (rect.width + gap);
        this.recentGrid.scrollBy({ left: delta, behavior: 'smooth' });
        // schedule arrow update after scroll ends
        clearTimeout(this._recentScrollT);
        this._recentScrollT = setTimeout(() => this.updateRecentArrows(), 350);
    }

    updateRecentArrows() {
        if (!this.recentGrid) return;
        const { scrollLeft, clientWidth, scrollWidth } = this.recentGrid;
        const atStart = scrollLeft <= 2;
        const atEnd = scrollLeft + clientWidth >= scrollWidth - 2;
        if (this.recentPrev) this.recentPrev.disabled = atStart;
        if (this.recentNext) this.recentNext.disabled = atEnd;
    }

    openLightbox(url, alt, variant = 'restored') {
        if (!this.lbModal || !this.lbOverlay || !this.lbImage) return;
        this.lbImage.src = url;
        if (alt) this.lbImage.alt = alt;
        this.lbVariant = variant;
        if (this.lbLabel) this.lbLabel.textContent = variant === 'original' ? 'Original' : 'Restored';
        if (this.lbDownload) {
            const a = variant === 'original' ? 'Download original image' : 'Download restored image';
            this.lbDownload.setAttribute('aria-label', a);
            this.lbDownload.setAttribute('title', a);
        }
        this.lbOverlay.hidden = false;
        this.lbModal.hidden = false;
        // Force reflow to enable transition
        void this.lbOverlay.offsetWidth;
        this.lbOverlay.classList.add('open');
        this.lbModal.classList.add('open');
        this.lbModal.setAttribute('aria-hidden', 'false');
        // ESC to close
        this._escHandler = (e) => { if (e.key === 'Escape') this.closeLightbox(); };
        window.addEventListener('keydown', this._escHandler);
    }

    closeLightbox() {
        if (!this.lbModal || !this.lbOverlay) return;
        this.lbOverlay.classList.remove('open');
        this.lbModal.classList.remove('open');
        this.lbModal.setAttribute('aria-hidden', 'true');
        setTimeout(() => {
            this.lbOverlay.hidden = true;
            this.lbModal.hidden = true;
        }, 200);
        if (this._escHandler) {
            window.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
    }

    downloadLightboxImage() {
        const variant = this.lbVariant || 'restored';
        if (variant === 'restored' && this.restoredImageData?.url) {
            this.downloadRestoredImage();
        } else if (variant === 'original' && this.currentImage?.file) {
            const link = document.createElement('a');
            link.href = this.currentImage.dataUrl;
            link.download = this.currentImage.file.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    openDrawer() {
        if (!this.buyDrawer || !this.drawerOverlay) return;
        this.buyDrawer.hidden = false;
        this.drawerOverlay.hidden = false;
        // Force reflow to enable transition
        void this.buyDrawer.offsetWidth;
        this.buyDrawer.classList.add('open');
        this.drawerOverlay.classList.add('open');
        this.buyDrawer.setAttribute('aria-hidden', 'false');
    }

    closeDrawer() {
        if (!this.buyDrawer || !this.drawerOverlay) return;
        this.buyDrawer.classList.remove('open');
        this.drawerOverlay.classList.remove('open');
        this.buyDrawer.setAttribute('aria-hidden', 'true');
        // Hide after transition
        setTimeout(() => {
            this.buyDrawer.hidden = true;
            this.drawerOverlay.hidden = true;
        }, 200);
    }

    async handleFileSelection(file) {
        if (!file.type.startsWith('image/')) {
            alert('Please select a valid image file.');
            return;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
            alert('File size too large. Please select an image under 10MB.');
            return;
        }

        try {
            // Convert file to base64
            const base64Image = await this.fileToBase64(file);
            this.currentImage = {
                file: file,
                base64: base64Image,
                dataUrl: URL.createObjectURL(file)
            };

            // Show original image
            this.originalImage.src = this.currentImage.dataUrl;

            // Start restoration process
            await this.processImage();
        } catch (error) {
            console.error('Error processing image:', error);
            alert('Error processing the image. Please try again.');
        }
    }

    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async processImage() {
        // Show processing section
        document.querySelector('.upload-section').style.display = 'none';
        this.processingSection.style.display = 'block';

        try {
            // Prefer direct Gemini image restoration only
            const restoredImageData = await this.geminiImageRestoration();
            
            if (restoredImageData) {
                this.restoredImageData = restoredImageData;
                this.showResults();
            } else {
                throw new Error('Failed to restore image');
            }
        } catch (error) {
            console.error('Restoration error:', error);
            const msg = (error && error.message) ? error.message : String(error);
            alert(`Failed to restore the image via Gemini.\n\nDetails: ${msg}`);
            this.resetInterface();
        }
    }

    async geminiImageRestoration() {
        try {
            console.log('🖼️ Restoring photo via Gemini image output...');
            const payload = {
                prompt: this.restorationPrompt,
                mimeType: this.currentImage.file.type,
                data: this.currentImage.base64,
            };

            const response = await fetch('/api/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                if (response.status === 402) {
                    await response.json().catch(() => ({}));
                    alert('Not enough credits.');
                    this.openDrawer();
                    return null;
                }
                // Try to extract server-side error details
                let detail = '';
                try { const t = await response.text(); detail = t?.slice(0, 400); } catch {}
                throw new Error(`Restore API error: ${response.status}${detail ? ' — ' + detail : ''}`);
            }

            const result = await response.json();
            // Update credits/free usage if server returned usage
            if (result && result.usage) {
                this.renderUsage(result.usage);
            } else {
                // Fallback: refresh from server to keep UI in sync
                this.refreshMe().catch(() => {});
            }
            if (!result?.data) {
                let snippet = '';
                try {
                    const slim = { error: result?.error, model: result?.model || null, raw: result?.raw };
                    const s = JSON.stringify(slim, null, 2);
                    snippet = s.length > 500 ? s.slice(0, 500) + '…' : s;
                } catch {}
                throw new Error(`Model did not return an image.${snippet ? '\n\nServer said:\n' + snippet : ''}`);
            }
            const mime = result.mimeType || 'image/jpeg';
            const byteChars = atob(result.data);
            const byteNumbers = new Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteNumbers[i] = byteChars.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mime });
            const url = URL.createObjectURL(blob);
            // Save to recent cache (best-effort)
            try { await this.saveRecent(this.currentImage.file, blob); } catch {}
            return { url, blob, analysis: null };
        } catch (err) {
            console.error('Gemini image restoration failed:', err);
            throw err;
        }
    }

    async refreshMe() {
        try {
            const r = await fetch('/api/me', { credentials: 'include' });
            const j = await r.json();
            if (r.ok) this.renderUsage(j);
        } catch {}
    }

    async refreshHealth() {
        try {
            const r = await fetch('/api/health', { credentials: 'include' });
            const j = await r.json();
            if (!r.ok) return;
            if (this.testBadge) {
                this.testBadge.hidden = true; // badge removed from UI
            }
            // Only update free/heading if server provided freeRemaining
            if (j && j.usage) {
                const update = { credits: j.usage.credits };
                if (typeof j.freeRemaining === 'number') update.freeRemaining = j.freeRemaining;
                this.renderUsage(update);
            }
        } catch {}
    }

    renderUsage(usage) {
        if (!usage) return;
        const credits = (usage.credits ?? usage?.usage?.credits) ?? 0;
        const freeRemaining = (usage.freeRemaining ?? usage?.usage?.freeRemaining);
        if (this.creditInfo) this.creditInfo.textContent = `Credits: ${credits}`;
        if (this.creditInfoTop) this.creditInfoTop.textContent = `Credits: ${credits}`;
        if (typeof freeRemaining === 'number') {
            this.updateUploadButtonLabel({ credits, freeRemaining });
        }
    }

    updateUploadButtonLabel(info) {
        if (!this.uploadBtn || !info) return;
        const free = Number(info.freeRemaining || 0);
        if (free > 0) {
            this.uploadBtn.textContent = 'Upload a Photo';
            this.uploadBtn.setAttribute('aria-label', 'Upload one Photo for free');
            this.uploadBtn.title = 'Your first restore is free';
            if (this.uploadHeading) this.uploadHeading.textContent = 'Restore a Photo - 1 Free';
        } else {
            this.uploadBtn.textContent = 'Upload a Photo';
            this.uploadBtn.setAttribute('aria-label', 'Upload a Photo (costs 100 credits)');
            this.uploadBtn.removeAttribute('title');
            if (this.uploadHeading) this.uploadHeading.textContent = 'Restore a Photo - 100 Credits';
        }
    }

    // Recent cache (IndexedDB)
    async openDB() {
        if (this._db) return this._db;
        this._db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('photo-restore-cache', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('restores')) {
                    const store = db.createObjectStore('restores', { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._db;
    }

    async saveRecent(originalFile, restoredBlob) {
        const db = await this.openDB();
        const id = (crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`);
        const item = {
            id,
            createdAt: Date.now(),
            originalName: originalFile?.name || 'photo.jpg',
            originalType: originalFile?.type || 'image/jpeg',
            restoredType: restoredBlob?.type || 'image/jpeg',
            originalBlob: originalFile,
            restoredBlob: restoredBlob,
        };
        await new Promise((resolve, reject) => {
            const tx = db.transaction('restores', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore('restores').put(item);
        });
        // Prune to last 20
        try { await this.pruneRecent(20); } catch {}
        await this.loadRecent();
    }

    async getAllRecent() {
        const db = await this.openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('restores', 'readonly');
            const store = tx.objectStore('restores');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async pruneRecent(max) {
        const items = await this.getAllRecent();
        if (items.length <= max) return;
        const sorted = items.sort((a,b) => b.createdAt - a.createdAt);
        const toDelete = sorted.slice(max).map(i => i.id);
        const db = await this.openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('restores', 'readwrite');
            const store = tx.objectStore('restores');
            toDelete.forEach(id => store.delete(id));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async clearRecentCache() {
        const db = await this.openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('restores', 'readwrite');
            tx.objectStore('restores').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        // Revoke any object URLs we created
        this._recentUrls.forEach(u => URL.revokeObjectURL(u));
        this._recentUrls.clear?.();
    }

    async loadRecent() {
        if (!this.recentGrid) return;
        const items = await this.getAllRecent();
        const sorted = items.sort((a,b) => b.createdAt - a.createdAt);
        // Hide section if empty
        if (!sorted.length) {
            if (this.recentSection) this.recentSection.hidden = true;
            this.recentGrid.innerHTML = '';
            // Revoke any previously created URLs
            this._recentUrls.forEach(u => URL.revokeObjectURL(u));
            this._recentUrls.clear?.();
            return;
        }
        if (this.recentSection) this.recentSection.hidden = false;
        // Clear and revoke old urls
        this._recentUrls.forEach(u => URL.revokeObjectURL(u));
        this._recentUrls.clear?.();
        this.recentGrid.innerHTML = '';
        sorted.forEach(item => {
            const card = document.createElement('div');
            card.className = 'recent-card';
            const thumbUrl = URL.createObjectURL(item.restoredBlob);
            this._recentUrls.add(thumbUrl);
            const when = new Date(item.createdAt);
            const whenText = `${when.toLocaleDateString()} ${when.toLocaleTimeString()}`;
            const alt = `Restored image ${whenText}`;
            card.innerHTML = `
              <div class="recent-thumb"><img alt="${alt}" src="${thumbUrl}"></div>
              <div class="recent-actions">
                <button class="btn btn-secondary act-open">Open</button>
                <button class="btn btn-secondary act-dl">Download</button>
              </div>`;
            const img = card.querySelector('img');
            img.addEventListener('click', () => this.openLightbox(thumbUrl, alt, 'restored'));
            card.querySelector('.act-open').addEventListener('click', () => this.openLightbox(thumbUrl, alt, 'restored'));
            card.querySelector('.act-dl').addEventListener('click', () => {
                const link = document.createElement('a');
                link.href = thumbUrl;
                const base = item.originalName.replace(/\.[^.]+$/, '') || 'restored';
                const ext = (item.restoredType && item.restoredType.includes('png')) ? 'png' : 'jpg';
                link.download = `restored_${base}.${ext}`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });
            this.recentGrid.appendChild(card);
        });
        this.updateRecentArrows();
    }

    async loadExamples() {
        if (!this.examplesGrid) return;
        try {
            const r = await fetch('/api/examples', { credentials: 'include' });
            const j = await r.json();
            if (!r.ok) return;
            this.examplesGrid.innerHTML = '';
            (j.items || []).forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'example-card';
                if (item.after) {
                    // Base layer: AFTER full image; overlay left side: BEFORE up to slider position
                    card.innerHTML = `
                      <div class="compare" data-pos="50">
                        <img class="after" src="${item.after}" alt="Example ${idx+1} after">
                        <div class="beforeWrap"><img class="before" src="${item.before}" alt="Example ${idx+1} before"></div>
                        <div class="divider"><div class="knob"></div></div>
                        <div class="labels"><span class="lbl before">Before</span><span class="lbl after">After</span></div>
                      </div>
                      <div class="example-meta">Example ${idx+1} — hover and move to compare</div>`;
                } else {
                    card.innerHTML = `
                      <div class="example-frame"><img src="${item.before}" alt="Example ${idx+1}"></div>
                      <div class="example-meta">Example ${idx+1}</div>`;
                }
                this.examplesGrid.appendChild(card);
            });
            this.initComparisons();
            if (!j.items || j.items.length === 0) {
                const msg = document.createElement('div');
                msg.style.color = 'var(--text-secondary)';
                msg.textContent = 'No examples found in /examples. Add files named before1.jpg and after1.jpg, etc.';
                this.examplesGrid.appendChild(msg);
            }
        } catch {}
    }

    initComparisons() {
        const comps = document.querySelectorAll('.compare');
        comps.forEach(comp => {
            // Set container height to match image aspect ratio (no resize/jump)
            const afterImg = comp.querySelector('img.after');
            const beforeImg = comp.querySelector('img.before');
            const setHeight = () => {
                const aW = afterImg.naturalWidth, aH = afterImg.naturalHeight;
                const bW = beforeImg?.naturalWidth, bH = beforeImg?.naturalHeight;
                const ratio = (bW && bH) ? (bH / bW) : (aH / aW);
                const w = comp.clientWidth;
                comp.style.height = (w * ratio) + 'px';
            };
            if (afterImg.complete && (!beforeImg || beforeImg.complete)) setHeight();
            afterImg.addEventListener('load', setHeight);
            beforeImg?.addEventListener('load', setHeight);
            window.addEventListener('resize', () => requestAnimationFrame(setHeight));

            let dragging = false;
            let needsFrame = false;
            let nextP = 50;
            const setPos = (p) => {
                const clamped = Math.max(0, Math.min(100, p));
                comp.style.setProperty('--pos', clamped + '%');
                comp.dataset.pos = clamped;
            };
            const computeP = (clientX) => {
                const rect = comp.getBoundingClientRect();
                const x = clientX - rect.left;
                return (x / rect.width) * 100;
            };
            const schedule = () => {
                if (needsFrame) return;
                needsFrame = true;
                requestAnimationFrame(() => {
                    setPos(nextP);
                    needsFrame = false;
                });
            };
            const pointerMove = (e) => {
                if (!dragging && e.pointerType !== 'mouse') return; // avoid passive jitter on touch unless dragging
                nextP = computeP(e.clientX);
                schedule();
            };
            comp.addEventListener('pointerdown', (e) => {
                dragging = true;
                comp.setPointerCapture?.(e.pointerId);
                nextP = computeP(e.clientX);
                schedule();
            });
            comp.addEventListener('pointermove', pointerMove);
            const end = (e) => { dragging = false; comp.releasePointerCapture?.(e.pointerId); };
            comp.addEventListener('pointerup', end);
            comp.addEventListener('pointercancel', end);
            comp.addEventListener('pointerleave', (e) => { if (dragging) end(e); });
            // Also support hover on desktop
            comp.addEventListener('mousemove', (e) => { if (!dragging) { nextP = computeP(e.clientX); schedule(); } });
            setPos(50);
        });
    }

    async geminiGuidedRestoration() {
        try {
            console.log('🔍 Analyzing photo with Gemini 2.5 Flash...');
            
            // First, analyze the photo with Gemini
            const analysis = await this.analyzePhotoWithGemini();
            
            console.log('🎨 Applying Gemini-guided restoration...');
            console.log('Analysis:', analysis);
            
            // Apply restoration based on Gemini's analysis
            return await this.applyGeminiGuidedEnhancement(analysis);
            
        } catch (error) {
            console.error('Gemini restoration error:', error);
            // Fallback to basic enhancement
            return await this.enhancedImageRestoration();
        }
    }

    async analyzePhotoWithGemini() {
        // Prefer secure server proxy. Fallback to direct if explicitly configured.
        const payload = {
            prompt: this.restorationPrompt,
            mimeType: this.currentImage.file.type,
            data: this.currentImage.base64,
        };

        const response = await fetch(this.serverEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Proxy error: ${response.status}`);
        }

        const result = await response.json();
        const parts = result?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text).filter(Boolean).join('\n').trim();
        if (text) return text;
        throw new Error('No analysis received from Gemini');
    }

    // Model selection removed; server uses default configured model.

    async applyGeminiGuidedEnhancement(analysis) {
        // Parse Gemini's analysis for restoration guidance
        const colorInstructions = this.parseColorInstructions(analysis);
        
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            
            img.onload = () => {
                // Upscale based on Gemini guidance
                canvas.width = img.width * 2.5;
                canvas.height = img.height * 2.5;
                
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                
                // Apply Gemini-guided colorization
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                
                // Apply intelligent colorization based on analysis
                this.applyIntelligentColorization(data, colorInstructions, analysis);
                
                ctx.putImageData(imageData, 0, 0);
                
                // Apply period-appropriate effects based on Gemini's era identification
                this.applyHistoricalEffects(ctx, canvas, analysis);
                
                canvas.toBlob((blob) => {
                    const url = URL.createObjectURL(blob);
                    resolve({
                        url: url,
                        blob: blob,
                        analysis: analysis
                    });
                }, 'image/jpeg', 0.95);
            };
            
            img.src = this.currentImage.dataUrl;
        });
    }

    parseColorInstructions(analysis) {
        const instructions = {
            skinTone: { r: 220, g: 180, b: 140 }, // Default warm skin tone
            clothing: { r: 80, g: 60, b: 40 },    // Default brown/khaki
            background: { r: 150, g: 140, b: 120 }, // Default earth tones
            sky: { r: 135, g: 206, b: 235 },      // Sky blue
            vegetation: { r: 34, g: 139, b: 34 }   // Forest green
        };
        
        // Parse specific color mentions in Gemini's analysis
        if (analysis.toLowerCase().includes('blue')) {
            if (analysis.toLowerCase().includes('uniform') || analysis.toLowerCase().includes('clothing')) {
                instructions.clothing = { r: 25, g: 25, b: 112 }; // Navy blue
            }
        }
        
        if (analysis.toLowerCase().includes('khaki') || analysis.toLowerCase().includes('military')) {
            instructions.clothing = { r: 195, g: 176, b: 145 }; // Khaki
        }
        
        if (analysis.toLowerCase().includes('brown')) {
            instructions.clothing = { r: 101, g: 67, b: 33 }; // Brown
        }
        
        // Look for RGB values in the analysis
        const rgbMatches = analysis.match(/rgb?\((\d+),\s*(\d+),\s*(\d+)\)/gi);
        if (rgbMatches) {
            // Use the first RGB value found as primary color guidance
            const rgb = rgbMatches[0].match(/(\d+)/g);
            instructions.primary = { r: parseInt(rgb[0]), g: parseInt(rgb[1]), b: parseInt(rgb[2]) };
        }
        
        return instructions;
    }

    applyIntelligentColorization(data, colorInstructions, analysis) {
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const gray = (r + g + b) / 3;
            
            // Only colorize if image is predominantly grayscale
            if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) {
                const brightness = gray / 255;
                
                // Apply different colorization based on brightness and position
                if (gray > 180) { // Very bright areas - likely sky or highlights
                    if (analysis.toLowerCase().includes('outdoor') || analysis.toLowerCase().includes('sky')) {
                        data[i] = Math.min(255, colorInstructions.sky.r * brightness);
                        data[i + 1] = Math.min(255, colorInstructions.sky.g * brightness);
                        data[i + 2] = Math.min(255, colorInstructions.sky.b * brightness);
                    } else {
                        data[i] = Math.min(255, gray * 1.1);
                        data[i + 1] = Math.min(255, gray * 1.05);
                        data[i + 2] = Math.min(255, gray * 1.0);
                    }
                } else if (gray > 120) { // Mid-tones - likely skin or clothing
                    const skinColor = colorInstructions.skinTone;
                    data[i] = Math.min(255, skinColor.r * brightness * 1.1);
                    data[i + 1] = Math.min(255, skinColor.g * brightness * 1.05);
                    data[i + 2] = Math.min(255, skinColor.b * brightness);
                } else if (gray > 60) { // Darker mid-tones - clothing/objects
                    const clothingColor = colorInstructions.clothing;
                    data[i] = Math.min(255, clothingColor.r * brightness * 1.2);
                    data[i + 1] = Math.min(255, clothingColor.g * brightness * 1.1);
                    data[i + 2] = Math.min(255, clothingColor.b * brightness * 1.0);
                } else { // Shadows and dark areas
                    data[i] = Math.min(255, gray * 1.1 + 10);
                    data[i + 1] = Math.min(255, gray * 1.05 + 5);
                    data[i + 2] = Math.min(255, gray * 1.0);
                }
            } else {
                // Enhance existing colors
                data[i] = Math.min(255, r * 1.15);
                data[i + 1] = Math.min(255, g * 1.15);
                data[i + 2] = Math.min(255, b * 1.15);
            }
        }
    }

    applyHistoricalEffects(ctx, canvas, analysis) {
        // Apply period-appropriate effects based on Gemini's era identification
        if (analysis.toLowerCase().includes('1940') || analysis.toLowerCase().includes('wwii') || analysis.toLowerCase().includes('world war')) {
            // WWII era - slightly warm, sepia-tinted
            ctx.globalCompositeOperation = 'overlay';
            ctx.fillStyle = 'rgba(139, 117, 80, 0.1)'; // Sepia overlay
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (analysis.toLowerCase().includes('1910') || analysis.toLowerCase().includes('1920') || analysis.toLowerCase().includes('wwi')) {
            // Early 20th century - more sepia
            ctx.globalCompositeOperation = 'overlay';
            ctx.fillStyle = 'rgba(160, 120, 80, 0.15)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        
        // Add subtle film grain for authenticity
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.03;
        for (let x = 0; x < canvas.width; x += 3) {
            for (let y = 0; y < canvas.height; y += 3) {
                if (Math.random() > 0.8) {
                    ctx.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }
        
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }

    async enhancedImageRestoration() {
        // Enhanced processing time
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // More sophisticated image enhancement for demo
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            
            img.onload = () => {
                canvas.width = img.width * 2; // Upscale
                canvas.height = img.height * 2;
                
                // Draw upscaled image
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                
                // Apply colorization and enhancement
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const gray = (r + g + b) / 3;
                    
                    // If image is mostly grayscale, add color
                    if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) {
                        // Add warm tones for skin/sepia effect
                        data[i] = Math.min(255, gray * 1.3 + 30);     // Red - warmer
                        data[i + 1] = Math.min(255, gray * 1.2 + 15); // Green
                        data[i + 2] = Math.min(255, gray * 1.1);      // Blue - cooler
                        
                        // Add some variation based on brightness
                        if (gray > 150) { // Bright areas (sky, highlights)
                            data[i] = Math.min(255, data[i] * 0.9 + 20);     // Slightly blue-shifted
                            data[i + 1] = Math.min(255, data[i + 1] + 10);
                            data[i + 2] = Math.min(255, data[i + 2] + 30);
                        } else if (gray < 80) { // Dark areas (shadows)
                            data[i] = Math.min(255, data[i] * 1.1);
                            data[i + 1] = Math.min(255, data[i + 1] * 1.05);
                            data[i + 2] = Math.min(255, data[i + 2] * 0.95);
                        }
                    } else {
                        // Enhance existing colors
                        data[i] = Math.min(255, r * 1.2);
                        data[i + 1] = Math.min(255, g * 1.2);
                        data[i + 2] = Math.min(255, b * 1.2);
                    }
                }
                
                ctx.putImageData(imageData, 0, 0);
                
                // Apply subtle film grain
                ctx.globalAlpha = 0.05;
                ctx.fillStyle = `rgb(${Math.random() * 20}, ${Math.random() * 20}, ${Math.random() * 20})`;
                for (let x = 0; x < canvas.width; x += 2) {
                    for (let y = 0; y < canvas.height; y += 2) {
                        if (Math.random() > 0.7) {
                            ctx.fillRect(x, y, 1, 1);
                        }
                    }
                }
                
                // Convert canvas to blob
                canvas.toBlob((blob) => {
                    const url = URL.createObjectURL(blob);
                    resolve({
                        url: url,
                        blob: blob
                    });
                }, 'image/jpeg', 0.95);
            };
            
            img.src = this.currentImage.dataUrl;
        });
    }

    showResults() {
        this.processingSection.style.display = 'none';
        this.resultsSection.style.display = 'block';
        
        // Display restored image
        this.restoredImage.src = this.restoredImageData.url;
        // Add zoom affordances
        this.originalFrame?.classList.add('zoomable');
        this.restoredFrame?.classList.add('zoomable');
        if (this.downloadBtn) {
            this.downloadBtn.classList.remove('icon-only');
            this.downloadBtn.textContent = 'Download';
            const a = 'Download the restored image';
            this.downloadBtn.setAttribute('title', a);
            this.downloadBtn.setAttribute('aria-label', a);
        }
        
        // Scroll to results
        this.resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

    downloadRestoredImage() {
        if (!this.restoredImageData) return;
        
        const link = document.createElement('a');
        link.href = this.restoredImageData.url;
        link.download = `restored_${this.currentImage.file.name}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    resetInterface() {
        // Reset file input
        this.fileInput.value = '';
        
        // Hide sections
        this.processingSection.style.display = 'none';
        this.resultsSection.style.display = 'none';
        
        // Show upload section
        document.querySelector('.upload-section').style.display = 'block';
        
        // Clean up object URLs
        if (this.currentImage?.dataUrl) {
            URL.revokeObjectURL(this.currentImage.dataUrl);
        }
        if (this.restoredImageData?.url) {
            URL.revokeObjectURL(this.restoredImageData.url);
        }
        this.closeLightbox?.();
        
        // Reset data
        this.currentImage = null;
        this.restoredImageData = null;
        
        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// Initialize the photo restorer when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const app = new PhotoRestorer();
    app.refreshMe();
    app.refreshHealth();
    app.loadExamples();
    app.loadRecent();
    // Auto-confirm Stripe checkout on success redirect
    (async () => {
        try {
            const qs = new URLSearchParams(location.search);
            const sess = qs.get('session_id');
            const p = qs.get('p');
            if (p === 'success' && sess) {
                const r = await fetch('/api/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ session_id: sess }) });
                await app.refreshMe();
                // Clean URL
                history.replaceState({}, document.title, location.pathname);
            }
        } catch {}
    })();
});

// Display API setup message
document.addEventListener('DOMContentLoaded', () => {
    console.log(`
🎨 GEMINI-POWERED PhotoRestore READY!

✅ GEMINI 2.5 FLASH INTEGRATION ACTIVE
- Photo analysis and historical context identification
- AI-guided colorization based on detailed restoration prompt
- Period-appropriate color palettes and effects
- Intelligent damage repair suggestions

🔧 RESTORATION PIPELINE:
1. Gemini analyzes the historical photo
2. Identifies time period, subjects, and optimal colors
3. Applies historically accurate colorization
4. Enhances resolution with period-appropriate effects
5. Preserves authentic film grain and characteristics

📸 FEATURES:
✓ AI-powered photo analysis with your detailed prompt
✓ Historically accurate color restoration
✓ 2.5x upscaling with quality preservation
✓ Period-specific effects (WWI, WWII, etc.)
✓ Natural skin tone and environment colorization
✓ Authentic film grain and vintage characteristics

Upload a historical photo to experience AI-guided restoration!
    `);
});
