/* app.js — ควบคุมหน้าจอ จัดการหน้าเอกสาร และบันทึกงานค้างใน IndexedDB */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // รอให้หน้าจอวาดสปินเนอร์ก่อนงานหนัก (ใช้ setTimeout เพราะ rAF หยุดเมื่อแอปอยู่เบื้องหลัง)
  const frame = () => new Promise(r => setTimeout(r, 40));
  const DEFAULT_FILTER = 'color';

  /* ---------- IndexedDB ---------- */
  const DB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const rq = indexedDB.open('offline-scanner', 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          db.createObjectStore('pages', { keyPath: 'id' });
          db.createObjectStore('meta');
        };
        rq.onsuccess = () => { this.db = rq.result; res(); };
        rq.onerror = () => rej(rq.error);
      });
    },
    tx(store, mode, fn) {
      return new Promise((res, rej) => {
        const t = this.db.transaction(store, mode), s = t.objectStore(store);
        let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    getAll() { return this.tx('pages', 'readonly', s => s.getAll()); },
    put(p) { return this.tx('pages', 'readwrite', s => s.put(p)); },
    del(id) { return this.tx('pages', 'readwrite', s => s.delete(id)); },
    clear() { return this.tx('pages', 'readwrite', s => s.clear()); },
    getOrder() { return this.tx('meta', 'readonly', s => s.get('order')); },
    setOrder(o) { return this.tx('meta', 'readwrite', s => s.put(o, 'order')); },
  };

  /* ---------- สถานะ ---------- */
  const state = { pages: new Map(), order: [], urls: new Map() };
  let edit = null; // { page, isNew, src, warpKey, warped, filtered }

  /* ---------- ตัวช่วย UI ---------- */
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function busy(on, text) {
    $('global-busy').hidden = !on;
    if (text) $('busy-text').textContent = text;
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- รายการหน้า ---------- */
  function renderList() {
    const ol = $('pages'); ol.innerHTML = '';
    state.order.forEach((id, i) => {
      const p = state.pages.get(id); if (!p) return;
      if (!state.urls.has(id)) state.urls.set(id, URL.createObjectURL(p.thumb));
      const li = document.createElement('li');
      li.className = 'page-card'; li.dataset.id = id;
      li.innerHTML = '<img alt=""><span class="num"></span><button class="handle" aria-label="ลากเพื่อเรียงลำดับ">≡</button>';
      li.querySelector('img').src = state.urls.get(id);
      li.querySelector('img').alt = 'หน้า ' + (i + 1);
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('img').addEventListener('click', () => openExisting(id));
      li.querySelector('.handle').addEventListener('pointerdown', e => startDrag(e, li));
      ol.appendChild(li);
    });
    const n = state.order.length;
    $('empty').hidden = n > 0;
    $('btn-export').disabled = n === 0;
    $('btn-export').textContent = n ? '📄 PDF (' + n + ')' : '📄 PDF';
    $('btn-clear').hidden = n === 0;
  }

  // ลากเรียงลำดับด้วยปุ่ม ≡
  function startDrag(e, li) {
    e.preventDefault();
    const handle = e.currentTarget; handle.setPointerCapture(e.pointerId);
    const ghost = li.querySelector('img').cloneNode(); ghost.className = 'drag-ghost';
    document.body.appendChild(ghost);
    li.classList.add('dragging');
    const content = li.closest('.content');
    let lastY = e.clientY, scrollTimer = null;
    const place = (x, y) => { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; };
    place(e.clientX, e.clientY);
    const autoscroll = () => {
      const r = content.getBoundingClientRect();
      if (lastY < r.top + 60) content.scrollTop -= 12;
      else if (lastY > r.bottom - 60) content.scrollTop += 12;
    };
    scrollTimer = setInterval(autoscroll, 30);
    const move = ev => {
      lastY = ev.clientY; place(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest('.page-card');
      if (target && target !== li) {
        const items = [...li.parentNode.children];
        if (items.indexOf(target) > items.indexOf(li)) target.after(li); else target.before(li);
      }
    };
    const up = async () => {
      clearInterval(scrollTimer);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      ghost.remove(); li.classList.remove('dragging');
      state.order = [...$('pages').children].map(c => c.dataset.id);
      await DB.setOrder(state.order);
      renderList();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /* ---------- นำเข้าภาพ ---------- */
  async function importFiles(files, interactive) {
    files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
    if (!files.length) return;
    if (files.length === 1 && interactive) {
      busy(true, 'กำลังหาขอบเอกสาร…'); await frame();
      try {
        const src = await Scan.loadImage(files[0]);
        const corners = Scan.detect(src) || Scan.defaultCorners();
        const page = { id: uid(), corners, filter: DEFAULT_FILTER, rotation: 0 };
        edit = { page, isNew: true, src, srcBlob: null };
        busy(false);
        openCrop();
      } catch (err) { busy(false); toast('เปิดรูปไม่ได้: ' + err.message); }
      return;
    }
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      busy(true, 'กำลังนำเข้า ' + (i + 1) + '/' + files.length + '…'); await frame();
      try {
        const src = await Scan.loadImage(files[i]);
        const corners = Scan.detect(src) || Scan.fullCorners();
        const page = { id: uid(), corners, filter: DEFAULT_FILTER, rotation: 0 };
        const out = await Scan.render(src, page);
        await savePage(page, src, out, true);
        ok++;
      } catch (err) { console.error(err); }
    }
    busy(false); renderList();
    toast('เพิ่ม ' + ok + ' หน้าแล้ว แตะที่หน้าเพื่อปรับขอบ/ฟิลเตอร์');
  }

  async function savePage(page, srcCanvas, outCanvas, isNew, srcBlob) {
    const out = await Scan.toBlob(outCanvas, 0.9);
    const thumb = await Scan.toBlob(Scan.scaleTo(outCanvas, 360), 0.8);
    const src = srcBlob || await Scan.toBlob(srcCanvas, 0.92);
    const rec = { id: page.id, corners: page.corners, filter: page.filter, rotation: page.rotation, src, out, thumb, w: outCanvas.width, h: outCanvas.height };
    await DB.put(rec);
    state.pages.set(rec.id, rec);
    if (state.urls.has(rec.id)) { URL.revokeObjectURL(state.urls.get(rec.id)); state.urls.delete(rec.id); }
    if (isNew && !state.order.includes(rec.id)) { state.order.push(rec.id); await DB.setOrder(state.order); }
  }

  async function openExisting(id) {
    const rec = state.pages.get(id); if (!rec) return;
    busy(true, 'กำลังเปิด…'); await frame();
    try {
      const src = await Scan.loadImage(rec.src);
      edit = { page: { id: rec.id, corners: rec.corners.map(c => ({ ...c })), filter: rec.filter, rotation: rec.rotation || 0 }, isNew: false, src, srcBlob: rec.src };
      busy(false);
      await openEdit();
    } catch (err) { busy(false); toast('เปิดหน้าไม่ได้'); }
  }

  /* ---------- จอปรับขอบ ---------- */
  const crop = { scale: 1, ox: 0, oy: 0, drag: -1 };
  function openCrop() {
    show('screen-crop');
    setTimeout(layoutCrop, 0);
  }
  function layoutCrop() {
    if (!edit) return;
    const stage = $('crop-stage'), r = stage.getBoundingClientRect();
    const src = edit.src, pad = 26;
    const s = Math.min((r.width - pad * 2) / src.width, (r.height - pad * 2) / src.height);
    const dw = src.width * s, dh = src.height * s;
    crop.scale = s; crop.ox = (r.width - dw) / 2; crop.oy = (r.height - dh) / 2; crop.dw = dw; crop.dh = dh;
    const cv = $('crop-canvas'), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(dw * dpr); cv.height = Math.round(dh * dpr);
    cv.style.width = dw + 'px'; cv.style.height = dh + 'px';
    cv.style.left = crop.ox + 'px'; cv.style.top = crop.oy + 'px';
    const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    drawQuad();
  }
  const toScreen = p => [crop.ox + p.x * crop.dw, crop.oy + p.y * crop.dh];
  function drawQuad() {
    const svg = $('crop-svg'), c = edit.page.corners.map(toScreen);
    let html = '<polygon class="quad" points="' + c.map(p => p.join(',')).join(' ') + '"/>';
    c.forEach(p => { html += '<circle class="h-ring" cx="' + p[0] + '" cy="' + p[1] + '" r="17"/><circle class="h-dot" cx="' + p[0] + '" cy="' + p[1] + '" r="6"/>'; });
    svg.innerHTML = html;
  }
  function svgPoint(e) {
    const r = $('crop-stage').getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function drawLoupe(pt) {
    const L = $('loupe'), ctx = L.getContext('2d'), src = edit.src;
    const p = edit.page.corners[crop.drag], zoom = 3;
    const sx = p.x * src.width, sy = p.y * src.height;
    const half = 60 / (crop.scale * zoom);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 120, 120);
    ctx.drawImage(src, sx - half, sy - half, half * 2, half * 2, 0, 0, 120, 120);
    ctx.strokeStyle = '#4d9bff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(60, 44); ctx.lineTo(60, 76); ctx.moveTo(44, 60); ctx.lineTo(76, 60); ctx.stroke();
    const r = $('crop-stage').getBoundingClientRect();
    let lx = pt[0] - 60, ly = pt[1] - 150;
    if (ly < 8) ly = pt[1] + 50;
    lx = Math.max(8, Math.min(r.width - 128, lx));
    L.style.left = lx + 'px'; L.style.top = ly + 'px'; L.style.display = 'block';
  }
  function initCropEvents() {
    const svg = $('crop-svg');
    svg.addEventListener('pointerdown', e => {
      if (!edit) return;
      const pt = svgPoint(e), c = edit.page.corners.map(toScreen);
      let best = -1, bd = 48;
      c.forEach((p, i) => { const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      crop.drag = best; crop.offX = c[best][0] - pt[0]; crop.offY = c[best][1] - pt[1];
      svg.setPointerCapture(e.pointerId);
      drawLoupe(pt);
    });
    svg.addEventListener('pointermove', e => {
      if (crop.drag < 0) return;
      const pt = svgPoint(e);
      const x = (pt[0] + crop.offX - crop.ox) / crop.dw, y = (pt[1] + crop.offY - crop.oy) / crop.dh;
      edit.page.corners[crop.drag] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      drawQuad(); drawLoupe(toScreen(edit.page.corners[crop.drag]));
    });
    const end = () => { crop.drag = -1; $('loupe').style.display = 'none'; };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if ($('screen-crop').classList.contains('active')) layoutCrop(); });

    $('crop-cancel').onclick = () => { edit = null; show('screen-list'); };
    $('crop-full').onclick = () => { edit.page.corners = Scan.fullCorners(); drawQuad(); };
    $('crop-auto').onclick = () => {
      const c = Scan.detect(edit.src);
      if (c) { edit.page.corners = c; drawQuad(); toast('พบขอบเอกสารแล้ว'); }
      else toast('หาขอบไม่เจอ ลองลากมุมเอง');
    };
    $('crop-ok').onclick = () => { if (!isConvex(edit.page.corners)) { toast('มุมไขว้กัน กรุณาจัดมุมใหม่'); return; } openEdit(); };
  }
  function isConvex(c) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
      const z = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (Math.abs(z) < 1e-6) return false;
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }

  /* ---------- จอฟิลเตอร์ ---------- */
  async function openEdit() {
    show('screen-edit');
    const idx = state.order.indexOf(edit.page.id);
    $('edit-title').textContent = idx >= 0 ? 'หน้า ' + (idx + 1) : 'หน้าใหม่ (' + (state.order.length + 1) + ')';
    $('edit-more').hidden = !edit.isNew;
    await refreshPreview();
  }
  // เรนเดอร์ทีละงานตามลำดับ เพื่อไม่ให้กดฟิลเตอร์/หมุน/เสร็จ ซ้อนกันแล้วได้ภาพผิด
  function refreshPreview() {
    if (!edit) return Promise.resolve();
    const e = edit;
    e.job = (e.job || Promise.resolve()).then(() => renderPreview(e)).catch(err => { console.error(err); toast('ประมวลผลภาพไม่สำเร็จ'); });
    return e.job;
  }
  async function renderPreview(edit) {
    const p = edit.page;
    document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('on', b.dataset.f === p.filter));
    $('edit-busy').hidden = false; await frame();
    const key = JSON.stringify(p.corners);
    if (edit.warpKey !== key) { edit.warped = Scan.warp(edit.src, p.corners); edit.warpKey = key; edit.filteredKey = null; }
    if (edit.filteredKey !== p.filter) {
      const c = Scan.makeCanvas(edit.warped.width, edit.warped.height);
      c.getContext('2d').drawImage(edit.warped, 0, 0);
      edit.filtered = Scan.applyFilter(c, p.filter); edit.filteredKey = p.filter;
    }
    edit.final = Scan.rotate(edit.filtered, p.rotation);
    const blob = await Scan.toBlob(Scan.scaleTo(edit.final, 1400), 0.85);
    const img = $('edit-img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(blob); img.src = img.dataset.url;
    $('edit-busy').hidden = true;
  }
  async function commitEdit() {
    if (!edit || edit.saving) return;
    edit.saving = true;
    busy(true, 'กำลังบันทึก…'); await frame();
    await edit.job;
    try {
      await savePage(edit.page, edit.src, edit.final, edit.isNew, edit.srcBlob);
    } catch (err) { toast('บันทึกไม่สำเร็จ: ' + err.message); }
    busy(false);
    edit = null; renderList(); show('screen-list');
  }
  function initEditEvents() {
    $('filters').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !edit || !b.dataset.f) return;
      edit.page.filter = b.dataset.f; refreshPreview();
    });
    $('edit-rotate').onclick = () => { if (!edit) return; edit.page.rotation = ((edit.page.rotation || 0) + 90) % 360; refreshPreview(); };
    $('edit-back').onclick = () => openCrop();
    $('edit-done').onclick = commitEdit;
    $('edit-more').onclick = async () => { await commitEdit(); openCamera(); };
    $('edit-delete').onclick = async () => {
      if (edit.isNew) { edit = null; show('screen-list'); return; }
      if (!confirm('ลบหน้านี้?')) return;
      const id = edit.page.id;
      await DB.del(id); state.pages.delete(id);
      state.order = state.order.filter(x => x !== id); await DB.setOrder(state.order);
      if (state.urls.has(id)) { URL.revokeObjectURL(state.urls.get(id)); state.urls.delete(id); }
      edit = null; renderList(); show('screen-list'); toast('ลบหน้าแล้ว');
    };
  }

  /* ---------- กล้องในแอป: แสดงกรอบเอกสารสด + ถ่ายอัตโนมัติ ---------- */
  const cam = {
    stream: null, running: false, timer: null, small: null,
    smooth: null, miss: 0, hist: [], cooldown: false, capturedQ: null, capturing: false,
    queue: Promise.resolve(), pending: 0, count: 0, auto: true, thumbUrl: null,
  };
  try { cam.auto = localStorage.getItem('scanner.auto') !== '0'; } catch (e) { /* ใช้ค่าเริ่มต้น */ }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('file-camera').click(); return; }
    show('screen-camera');
    cam.count = 0; cam.smooth = null; cam.hist = []; cam.cooldown = false;
    if (cam.thumbUrl) { URL.revokeObjectURL(cam.thumbUrl); cam.thumbUrl = null; }
    $('cam-thumb').removeAttribute('src');
    updateCamUI();
    startStream();
  }
  async function startStream() {
    stopStream();
    setHint('กำลังเปิดกล้อง…');
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      });
    } catch (err) {
      console.warn(err);
      setHint('เปิดกล้องในแอปไม่ได้ — กดปุ่ม 📷 มุมขวาบนเพื่อใช้กล้องของระบบ');
      return;
    }
    if (!$('screen-camera').classList.contains('active')) { stopStream(); return; }
    const v = $('cam-video');
    v.srcObject = cam.stream;
    try { await v.play(); } catch (e) { /* autoplay จะเล่นเองเมื่อพร้อม */ }
    cam.running = true;
    setHint('เล็งกล้องให้เห็นกระดาษทั้งแผ่น');
    camLoop();
  }
  function stopStream() {
    cam.running = false;
    clearTimeout(cam.timer);
    if (cam.stream) { cam.stream.getTracks().forEach(t => t.stop()); cam.stream = null; }
    const v = $('cam-video'); if (v) v.srcObject = null;
  }
  function setHint(text, good) {
    const el = $('cam-hint'); el.textContent = text; el.classList.toggle('good', !!good);
  }
  function updateCamUI() {
    $('cam-count').hidden = cam.count === 0;
    $('cam-count').textContent = cam.count;
    $('cam-auto').classList.toggle('on', cam.auto);
    $('cam-auto').textContent = cam.auto ? 'ถ่ายอัตโนมัติ: เปิด' : 'ถ่ายอัตโนมัติ: ปิด';
    $('cam-done').textContent = cam.count ? 'เสร็จ (' + cam.count + ')' : 'เสร็จ';
    $('cam-shutter').classList.toggle('busy', cam.pending > 0);
  }

  function camLoop() {
    if (!cam.running) return;
    const v = $('cam-video');
    if (v.readyState >= 2 && v.videoWidth) {
      const s = 360 / Math.max(v.videoWidth, v.videoHeight);
      const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
      if (!cam.small || cam.small.width !== w || cam.small.height !== h) cam.small = Scan.makeCanvas(w, h);
      cam.small.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, w, h);
      let q = null;
      try { q = Scan.detect(cam.small, { fast: true, prev: cam.smooth }); } catch (e) { console.warn(e); }
      handleDetection(q);
    }
    cam.timer = setTimeout(camLoop, 80);
  }

  const qDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

  function handleDetection(q) {
    const now = performance.now();
    if (q) {
      cam.miss = 0;
      cam.smooth = !cam.smooth || qDist(cam.smooth, q) > 0.08 ? q.map(p => ({ ...p }))
        : cam.smooth.map((p, i) => ({ x: p.x * 0.45 + q[i].x * 0.55, y: p.y * 0.45 + q[i].y * 0.55 }));
      cam.hist.push({ t: now, q });
      while (cam.hist.length && now - cam.hist[0].t > 1100) cam.hist.shift();
    } else if (++cam.miss > 4) {
      cam.smooth = null; cam.hist = []; cam.cooldown = false;
    }
    // ปลดล็อกการถ่ายอัตโนมัติเมื่อเปลี่ยนไปหน้าใหม่ (กรอบขยับไปมาก)
    if (cam.cooldown && cam.smooth && cam.capturedQ && qDist(cam.smooth, cam.capturedQ) > 0.1) cam.cooldown = false;

    let stable = false;
    if (cam.smooth && cam.hist.length >= 6 && now - cam.hist[0].t > 800) {
      const last = cam.hist[cam.hist.length - 1].q;
      const near = cam.hist.filter(hh => qDist(hh.q, last) < 0.02).length;
      stable = near >= cam.hist.length * 0.8;
    }
    drawOverlay(stable);

    if (!cam.smooth) setHint('เล็งกล้องให้เห็นกระดาษทั้งแผ่น');
    else if (cam.cooldown) setHint('ถ่ายแล้ว ✓ เปลี่ยนหน้าถัดไปได้เลย', true);
    else if (!cam.auto) setHint('พบเอกสารแล้ว กดปุ่มถ่ายภาพ', true);
    else if (stable) setHint('กำลังถ่าย…', true);
    else setHint('พบเอกสารแล้ว ถือนิ่ง ๆ', true);

    if (cam.auto && stable && !cam.cooldown && !cam.capturing) capture(true);
  }

  function drawOverlay(stable) {
    const cv = $('cam-overlay'), v = $('cam-video'), r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    if (!cam.smooth || !v.videoWidth) return;
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s, ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const pts = cam.smooth.map(p => [ox + p.x * dw, oy + p.y * dh]);
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    ctx.fillStyle = stable ? 'rgba(30, 200, 120, .28)' : 'rgba(61, 127, 224, .28)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = stable ? '#2ee59d' : '#4d9bff'; ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fill(); });
  }

  function capture(auto) {
    const v = $('cam-video');
    if (cam.capturing || !v.videoWidth) return;
    cam.capturing = true;
    const s = Math.min(1, 3000 / Math.max(v.videoWidth, v.videoHeight));
    const frameCanvas = Scan.makeCanvas(v.videoWidth * s, v.videoHeight * s);
    const fctx = frameCanvas.getContext('2d'); fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(v, 0, 0, frameCanvas.width, frameCanvas.height);
    const fl = $('cam-flash'); fl.classList.add('go'); setTimeout(() => fl.classList.remove('go'), 60);
    if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) { /* ไม่รองรับ */ }

    const live = cam.smooth ? cam.smooth.map(p => ({ ...p })) : null;
    cam.cooldown = true; cam.capturedQ = live; cam.hist = [];
    cam.count++; cam.pending++; updateCamUI();
    cam.queue = cam.queue.then(async () => {
      await frame();
      const corners = live ? Scan.snap(frameCanvas, live) : (Scan.detect(frameCanvas) || Scan.fullCorners());
      const page = { id: uid(), corners, filter: DEFAULT_FILTER, rotation: 0 };
      const out = await Scan.render(frameCanvas, page);
      await savePage(page, frameCanvas, out, true);
      const rec = state.pages.get(page.id);
      if (cam.thumbUrl) URL.revokeObjectURL(cam.thumbUrl);
      cam.thumbUrl = URL.createObjectURL(rec.thumb); $('cam-thumb').src = cam.thumbUrl;
    }).catch(err => { console.error(err); cam.count--; toast('บันทึกภาพไม่สำเร็จ'); })
      .finally(() => { cam.pending--; updateCamUI(); });
    setTimeout(() => { cam.capturing = false; }, auto ? 900 : 400);
  }

  async function closeCamera() {
    stopStream();
    if (cam.pending) { busy(true, 'กำลังบันทึกหน้าที่ถ่าย…'); await cam.queue; busy(false); }
    renderList(); show('screen-list');
    if (cam.count) toast('เพิ่ม ' + cam.count + ' หน้าแล้ว แตะที่หน้าเพื่อปรับขอบหรือฟิลเตอร์');
  }

  function initCameraEvents() {
    $('cam-close').onclick = closeCamera;
    $('cam-done').onclick = closeCamera;
    $('cam-thumb-btn').onclick = closeCamera;
    $('cam-shutter').onclick = () => capture(false);
    $('cam-auto').onclick = () => {
      cam.auto = !cam.auto; cam.hist = [];
      try { localStorage.setItem('scanner.auto', cam.auto ? '1' : '0'); } catch (e) { /* ไม่เป็นไร */ }
      updateCamUI();
    };
    // ใช้กล้องของระบบ (สำรอง) — ต้องเรียก click ทันทีในจังหวะที่ผู้ใช้แตะ
    $('cam-system').onclick = () => { $('file-camera').click(); closeCamera(); };
    document.addEventListener('visibilitychange', () => {
      if (!$('screen-camera').classList.contains('active')) return;
      if (document.hidden) stopStream(); else startStream();
    });
  }

  /* ---------- ส่งออก PDF ---------- */
  const exp = { paper: 'a4', quality: 'mid', file: null, url: null };
  function defaultName() {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    return 'สแกน_' + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes());
  }
  function resetExport() {
    exp.file = null;
    if (exp.url) { URL.revokeObjectURL(exp.url); exp.url = null; }
    $('pdf-make').hidden = false; $('pdf-share').hidden = true; $('pdf-open').hidden = true;
    $('pdf-info').textContent = state.order.length + ' หน้า';
  }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  async function makePdf() {
    const q = PDF.QUALITY[exp.quality];
    let name = ($('pdf-name').value || defaultName()).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '');
    const pages = [];
    try {
      for (let i = 0; i < state.order.length; i++) {
        busy(true, 'กำลังสร้าง PDF หน้า ' + (i + 1) + '/' + state.order.length + '…'); await frame();
        const rec = state.pages.get(state.order[i]);
        const c = Scan.scaleTo(await Scan.loadImage(rec.out), q.side);
        const jpeg = new Uint8Array(await (await Scan.toBlob(c, q.q)).arrayBuffer());
        pages.push({ jpeg, w: c.width, h: c.height });
      }
      const blob = PDF.build(pages, { paper: exp.paper, title: name });
      exp.file = new File([blob], name + '.pdf', { type: 'application/pdf' });
      exp.url = URL.createObjectURL(exp.file);
      const canShare = navigator.canShare && navigator.canShare({ files: [exp.file] });
      $('pdf-info').textContent = '✓ ' + name + '.pdf — ' + pages.length + ' หน้า, ' + fmtSize(blob.size);
      $('pdf-make').hidden = true;
      $('pdf-share').hidden = !canShare;
      const a = $('pdf-open'); a.href = exp.url; a.hidden = false;
      if (canShare) { a.removeAttribute('download'); a.textContent = 'เปิดดูไฟล์'; }
      else { a.download = name + '.pdf'; a.textContent = 'ดาวน์โหลด PDF'; }
    } catch (err) { console.error(err); toast('สร้าง PDF ไม่สำเร็จ: ' + err.message); }
    busy(false);
  }
  function initExportEvents() {
    $('btn-export').onclick = () => { $('pdf-name').value = defaultName(); resetExport(); $('export-sheet').hidden = false; };
    $('pdf-close').onclick = () => { $('export-sheet').hidden = true; };
    $('export-sheet').addEventListener('click', e => { if (e.target.id === 'export-sheet') $('export-sheet').hidden = true; });
    const seg = (id, key) => $(id).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      exp[key] = b.dataset.v;
      $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      resetExport();
    });
    seg('seg-paper', 'paper'); seg('seg-quality', 'quality');
    $('pdf-name').addEventListener('input', () => { if (exp.file) resetExport(); });
    $('pdf-make').onclick = makePdf;
    $('pdf-share').onclick = async () => {
      if (!exp.file) return;
      try { await navigator.share({ files: [exp.file], title: exp.file.name }); }
      catch (err) { if (err.name !== 'AbortError') toast('แชร์ไม่สำเร็จ ลองกด "เปิดดูไฟล์" แทน'); }
    };
  }

  /* ---------- เริ่มต้น ---------- */
  async function init() {
    $('btn-camera').onclick = () => openCamera();
    initCameraEvents();
    $('btn-gallery').onclick = () => $('file-gallery').click();
    $('file-camera').onchange = e => { const f = e.target.files; if (f && f.length) importFiles(f, true); e.target.value = ''; };
    $('file-gallery').onchange = e => { const f = e.target.files; if (f && f.length) importFiles(f, true); e.target.value = ''; };
    $('btn-clear').onclick = async () => {
      if (!confirm('ลบทุกหน้าที่สแกนไว้?')) return;
      await DB.clear(); await DB.setOrder([]);
      state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls.clear();
      state.pages.clear(); state.order = []; renderList();
    };
    initCropEvents(); initEditEvents(); initExportEvents();

    try {
      await DB.open();
      const all = await DB.getAll();
      all.forEach(p => state.pages.set(p.id, p));
      const order = (await DB.getOrder()) || [];
      state.order = order.filter(id => state.pages.has(id));
      all.forEach(p => { if (!state.order.includes(p.id)) state.order.push(p.id); });
    } catch (err) { console.error(err); toast('ไม่สามารถบันทึกงานในเครื่องได้'); }
    renderList();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
    }
  }

  // เปิดให้ทดสอบจากคอนโซล
  window.ScannerApp = { importFiles, state, cam: () => cam, handleDetection: q => handleDetection(q), capture: a => capture(a) };
  init();
})();
