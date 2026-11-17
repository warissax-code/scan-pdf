/* scan.js — ตรวจจับขอบเอกสาร, ดัดหน้าตรง (perspective warp), ฟิลเตอร์ภาพ
   ทำงานในเครื่องทั้งหมด ไม่ใช้ไลบรารีภายนอก */
(function () {
  'use strict';

  const MAX_SRC = 3000;   // ด้านยาวสุดของภาพต้นฉบับที่เก็บ
  const MAX_OUT = 2480;   // ด้านยาวสุดของหน้าที่ดัดแล้ว (~300dpi A4)
  const DET = 420;        // ขนาดภาพย่อสำหรับตรวจจับขอบ

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* ---------- โหลดภาพ (เบราว์เซอร์จะหมุนตาม EXIF ให้อัตโนมัติ) ---------- */
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
        const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดรูปไม่ได้')); };
      img.src = url;
    });
  }

  /* ---------- ตรวจจับขอบ ---------- */
  function grayOf(canvas, maxSide) {
    const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const c = makeCanvas(canvas.width * s, canvas.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const w = c.width, h = c.height, g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return { g, w, h };
  }

  function blur(src, w, h) { // [1 4 6 4 1] แยกแกน
    const k = [1, 4, 6, 4, 1], tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); s += src[y * w + xx] * k[i + 2]; }
      tmp[y * w + x] = s / 16;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); s += tmp[yy * w + x] * k[i + 2]; }
      out[y * w + x] = s / 16;
    }
    return out;
  }

  function otsu(values, bins, maxV) {
    const hist = new Float64Array(bins);
    for (let i = 0; i < values.length; i++) hist[Math.min(bins - 1, Math.floor(values[i] / maxV * bins))]++;
    const total = values.length; let sum = 0;
    for (let i = 0; i < bins; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 0;
    for (let i = 0; i < bins; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = i; }
    }
    return (th + 0.5) / bins * maxV;
  }

  function dilate(m, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) o[yy * w + xx] = 1; }
      }
    }
    return o;
  }

  // ป้ายกำกับกลุ่มพิกเซล (mask=1) แล้วคืนกลุ่มที่ใหญ่ที่สุด
  function largestComponent(mask, w, h) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    let best = null, id = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || lab[start]) continue;
      id++; let sp = 0, n = 0; stack[sp++] = start; lab[start] = id;
      const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
      const minY = new Int32Array(w).fill(h), maxY = new Int32Array(w).fill(-1);
      let touches = 0;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w; n++;
        if (x < minX[y]) minX[y] = x; if (x > maxX[y]) maxX[y] = x;
        if (y < minY[x]) minY[x] = y; if (y > maxY[x]) maxY[x] = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (!best || n > best.n) best = { n, minX, maxX, minY, maxY, touches };
    }
    return best;
  }

  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    return Math.abs(a) / 2;
  }
  // ลดจุดของ hull ทีละจุด (ตัดจุดที่เสียพื้นที่น้อยสุด) จนเหลือ 4 มุม
  function reduceToQuad(p) {
    p = p.slice();
    while (p.length > 4) {
      let bi = 0, bv = Infinity;
      for (let i = 0; i < p.length; i++) {
        const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
        const v = Math.abs(cross(a, b, c));
        if (v < bv) { bv = v; bi = i; }
      }
      p.splice(bi, 1);
    }
    return p;
  }
  function orderCorners(q) { // คืน [tl, tr, br, bl]
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    q = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0, bs = Infinity;
    q.forEach((p, i) => { if (p[0] + p[1] < bs) { bs = p[0] + p[1]; k = i; } });
    return q.slice(k).concat(q.slice(0, k));
  }

  // ปรับมุมให้แม่นขึ้น: ฟิตเส้นตรงกับจุดขอบของแต่ละด้าน แล้วหาจุดตัด
  function refineQuad(q, comp, w, h, inset) {
    const pts = [];
    for (let y = 0; y < h; y++) if (comp.maxX[y] >= 0) { pts.push([comp.minX[y], y + 0.5]); pts.push([comp.maxX[y] + 1, y + 0.5]); }
    for (let x = 0; x < w; x++) if (comp.maxY[x] >= 0) { pts.push([x + 0.5, comp.minY[x]]); pts.push([x + 0.5, comp.maxY[x] + 1]); }
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 4) return q;
      const ux = dx / L, uy = dy / L, tol = Math.max(2.5, L * 0.025);
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
      for (const p of pts) {
        const t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
        if (t < L * 0.12 || t > L * 0.88) continue;
        const dist = Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
        if (dist > tol) continue;
        sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; n++;
      }
      if (n < 6) return q;
      const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      let nx = -Math.sin(ang), ny = Math.cos(ang);           // เวกเตอร์ตั้งฉากกับเส้น
      if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } // ชี้เข้าด้านใน
      lines.push({ nx, ny, c: nx * mx + ny * my + inset });   // nx*x + ny*y = c
    }
    const out = [];
    for (let i = 0; i < 4; i++) { // มุม i อยู่ระหว่างด้าน i-1 กับ i
      const A = lines[(i + 3) % 4], B = lines[i], det = A.nx * B.ny - A.ny * B.nx;
      if (Math.abs(det) < 1e-6) return q;
      const x = (A.c * B.ny - A.ny * B.c) / det, y = (A.nx * B.c - A.c * B.nx) / det;
      if (Math.hypot(x - q[i][0], y - q[i][1]) > Math.max(w, h) * 0.08) return q;
      out.push([x, y]);
    }
    return out;
  }

  function quadFromComponent(comp, w, h, inset) {
    if (!comp || comp.n < w * h * 0.06) return null;
    const pts = [];
    for (let y = 0; y < h; y++) if (comp.maxX[y] >= 0) { pts.push([comp.minX[y], y]); pts.push([comp.maxX[y] + 1, y]); pts.push([comp.minX[y], y + 1]); pts.push([comp.maxX[y] + 1, y + 1]); }
    if (pts.length < 8) return null;
    const hl = hull(pts);
    if (hl.length < 4) return null;
    const q = reduceToQuad(hl), qa = polyArea(q), ia = w * h;
    const ratio = qa / ia, fill = comp.n / qa;
    if (ratio < 0.08 || ratio > 0.985 || fill < 0.82) return null;
    // ตรวจว่ามุมไม่แคบเกินไป
    const o = orderCorners(q);
    for (let i = 0; i < 4; i++) {
      const a = o[(i + 3) % 4], b = o[i], c = o[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      if (Math.abs(cos) > 0.72) return null; // มุมต้องอยู่ราว 44°–136°
    }
    return { quad: refineQuad(o, comp, w, h, inset || 0), score: ratio + fill * 0.5 };
  }

  function detect(canvas) {
    const { g, w, h } = grayOf(canvas, DET);
    const b = blur(blur(g, w, h), w, h);

    // วิธี ก: หาเส้นขอบ (Sobel) แล้วหาพื้นที่ที่ถูกขอบล้อมรอบ
    const mag = new Float32Array(w * h); let maxM = 1;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1];
      const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
      const m = Math.hypot(gx, gy); mag[i] = m; if (m > maxM) maxM = m;
    }
    const cands = [];
    for (const f of [0.35, 0.6, 1, 1.6]) {
      const t = Math.max(18, otsu(mag, 128, maxM) * f);
      let edge = new Uint8Array(w * h);
      for (let i = 0; i < edge.length; i++) edge[i] = mag[i] > t ? 1 : 0;
      edge = dilate(dilate(edge, w, h), w, h);
      // เติมพื้นหลังจากขอบภาพ
      const reach = new Uint8Array(w * h), st = new Int32Array(w * h); let sp = 0;
      const push = p => { if (!edge[p] && !reach[p]) { reach[p] = 1; st[sp++] = p; } };
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (sp) {
        const p = st[--sp], x = p % w;
        if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
        if (p >= w) push(p - w); if (p < w * (h - 1)) push(p + w);
      }
      const inside = new Uint8Array(w * h);
      for (let i = 0; i < inside.length; i++) inside[i] = reach[i] ? 0 : 1;
      const r = quadFromComponent(largestComponent(inside, w, h), w, h, 2);
      if (r) { r.score += 0.03; cands.push(r); }
    }
    // วิธี ข: กระดาษสว่างกว่าพื้นหลัง (Otsu)
    {
      const t = otsu(b, 256, 256), bright = new Uint8Array(w * h);
      for (let i = 0; i < bright.length; i++) bright[i] = b[i] > t ? 1 : 0;
      const r = quadFromComponent(largestComponent(bright, w, h), w, h);
      if (r) cands.push(r);
    }
    if (!cands.length) return null;
    cands.sort((a, b2) => b2.score - a.score);
    const norm = cands[0].quad.map(([x, y]) => ({ x: x / w, y: y / h }));
    return snapEdges(canvas, norm).map(p => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }));
  }

  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    return { nx, ny, c: nx * mx + ny * my };
  }

  // ดูดแต่ละด้านเข้าหาขอบจริงบนภาพความละเอียดสูงขึ้น (หาจุดที่ความสว่างเปลี่ยนมากที่สุดตามแนวตั้งฉาก)
  function snapEdges(canvas, corners) {
    const { g, w, h } = grayOf(canvas, 1200);
    const b = blur(g, w, h);
    const at = (x, y) => {
      if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
      const t = b[i] + (b[i + 1] - b[i]) * fx, u = b[i + w] + (b[i + w + 1] - b[i + w]) * fx;
      return t + (u - t) * fy;
    };
    const q = corners.map(p => [p.x * w, p.y * h]);
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const R = Math.max(6, Math.round(Math.max(w, h) * 0.03));
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], c = q[(i + 1) % 4], dx = c[0] - a[0], dy = c[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 10) return corners;
      let nx = -dy / L, ny = dx / L;
      if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      let pts = [];
      for (let k = 0; k <= 40; k++) {
        const t = 0.08 + 0.84 * k / 40, px = a[0] + dx * t, py = a[1] + dy * t;
        let best = 0, bs = 0;
        for (let s2 = -R; s2 <= R; s2++) {
          const x = px + nx * s2, y = py + ny * s2;
          if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
          const d = Math.abs(at(x + nx, y + ny) - at(x - nx, y - ny));
          if (d > best) { best = d; bs = s2; }
        }
        if (best > 6) pts.push([px + nx * bs, py + ny * bs]);
      }
      if (pts.length < 8) { lines.push(null); continue; }
      let ln = fitLine(pts);
      for (let it = 0; it < 2; it++) { // ตัดจุดที่หลุดเส้น
        const res = pts.map(p => Math.abs(ln.nx * p[0] + ln.ny * p[1] - ln.c));
        const sorted = res.slice().sort((x, y) => x - y), lim = Math.max(1.5, sorted[Math.floor(sorted.length * 0.6)] * 2.5);
        const keep = pts.filter((_, j) => res[j] <= lim);
        if (keep.length < 8) break;
        pts = keep; ln = fitLine(pts);
      }
      lines.push(ln);
    }
    return q.map((p, i) => {
      const A = lines[(i + 3) % 4], B = lines[i];
      if (!A || !B) return { x: p[0] / w, y: p[1] / h };
      const det = A.nx * B.ny - A.ny * B.nx;
      if (Math.abs(det) < 1e-6) return { x: p[0] / w, y: p[1] / h };
      const x = (A.c * B.ny - A.ny * B.c) / det, y = (A.nx * B.c - A.c * B.nx) / det;
      if (Math.hypot(x - p[0], y - p[1]) > R * 2) return { x: p[0] / w, y: p[1] / h };
      return { x: x / w, y: y / h };
    });
  }

  function defaultCorners() {
    const m = 0.04;
    return [{ x: m, y: m }, { x: 1 - m, y: m }, { x: 1 - m, y: 1 - m }, { x: m, y: 1 - m }];
  }
  function fullCorners() {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  }

  /* ---------- ดัดหน้าตรง ---------- */
  function solve(A, b) { // Gaussian elimination
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }
  function homography(from, to) { // หา H ที่ to = H·from
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b); h.push(1);
    return h;
  }

  function warp(src, corners) {
    const W = src.width, H = src.height;
    const q = corners.map(p => [p.x * W, p.y * H]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let ow = Math.max(d(q[0], q[1]), d(q[3], q[2]));
    let oh = Math.max(d(q[0], q[3]), d(q[1], q[2]));
    const s = Math.min(1, MAX_OUT / Math.max(ow, oh));
    ow = Math.max(8, Math.round(ow * s)); oh = Math.max(8, Math.round(oh * s));
    const h = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);

    const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const out = makeCanvas(ow, oh), octx = out.getContext('2d');
    const img = octx.createImageData(ow, oh), od = img.data;
    for (let y = 0; y < oh; y++) {
      const yy = y + 0.5;
      for (let x = 0; x < ow; x++) {
        const xx = x + 0.5;
        const z = h[6] * xx + h[7] * yy + 1;
        let sx = (h[0] * xx + h[1] * yy + h[2]) / z - 0.5;
        let sy = (h[3] * xx + h[4] * yy + h[5]) / z - 0.5;
        if (sx < 0) sx = 0; else if (sx > W - 1.001) sx = W - 1.001;
        if (sy < 0) sy = 0; else if (sy > H - 1.001) sy = H - 1.001;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
        const o = (y * ow + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          od[o + c] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  /* ---------- ฟิลเตอร์ ---------- */
  // ค่าเฉลี่ยความสว่างรอบพิกเซล (คำนวณบนภาพย่อแล้วขยายกลับ เพื่อประหยัดหน่วยความจำ)
  function localMean(lum, w, h, radiusFrac) {
    const f = 4, sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
    const small = new Float64Array(sw * sh), cnt = new Float64Array(sw * sh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = ((y / f) | 0) * sw + ((x / f) | 0); small[k] += lum[y * w + x]; cnt[k]++;
    }
    for (let i = 0; i < small.length; i++) small[i] /= cnt[i];
    const r = Math.max(2, Math.round(Math.max(sw, sh) * radiusFrac));
    const I = new Float64Array((sw + 1) * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let row = 0;
      for (let x = 0; x < sw; x++) { row += small[y * sw + x]; I[(y + 1) * (sw + 1) + x + 1] = I[y * (sw + 1) + x + 1] + row; }
    }
    const mean = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(sw, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(sh, y + r + 1);
      const s = I[y1 * (sw + 1) + x1] - I[y0 * (sw + 1) + x1] - I[y1 * (sw + 1) + x0] + I[y0 * (sw + 1) + x0];
      mean[y * sw + x] = s / ((x1 - x0) * (y1 - y0));
    }
    return (x, y) => { // bilinear
      let fx = x / f - 0.5, fy = y / f - 0.5;
      if (fx < 0) fx = 0; if (fy < 0) fy = 0;
      if (fx > sw - 1) fx = sw - 1; if (fy > sh - 1) fy = sh - 1;
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      const t = mean[y0 * sw + x0] * (1 - ax) + mean[y0 * sw + x1] * ax;
      const b = mean[y1 * sw + x0] * (1 - ax) + mean[y1 * sw + x1] * ax;
      return t * (1 - ay) + b * ay;
    };
  }

  // ประมาณสีพื้นกระดาษรอบแต่ละจุด: ย่อภาพ → max filter (ลบตัวหนังสือ) → เบลอ
  function backgroundMap(ch, w, h, floor) {
    const f = 4, sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
    const small = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = ((y / f) | 0) * sw + ((x / f) | 0); small[k] += ch[y * w + x]; cnt[k]++;
    }
    for (let i = 0; i < small.length; i++) small[i] /= cnt[i];
    const r = Math.max(3, Math.round(Math.max(sw, sh) * 0.018));
    const tmp = new Float32Array(sw * sh), mx = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0; for (let i = Math.max(0, x - r); i <= Math.min(sw - 1, x + r); i++) { const v = small[y * sw + i]; if (v > m) m = v; }
      tmp[y * sw + x] = m;
    }
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0; for (let i = Math.max(0, y - r); i <= Math.min(sh - 1, y + r); i++) { const v = tmp[i * sw + x]; if (v > m) m = v; }
      mx[y * sw + x] = Math.max(floor, m);
    }
    const R = r * 2, I = new Float64Array((sw + 1) * (sh + 1));
    for (let y = 0; y < sh; y++) { let row = 0; for (let x = 0; x < sw; x++) { row += mx[y * sw + x]; I[(y + 1) * (sw + 1) + x + 1] = I[y * (sw + 1) + x + 1] + row; } }
    const bg = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(sw, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(sh, y + R + 1);
      bg[y * sw + x] = (I[y1 * (sw + 1) + x1] - I[y0 * (sw + 1) + x1] - I[y1 * (sw + 1) + x0] + I[y0 * (sw + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let fy = y / f - 0.5; if (fy < 0) fy = 0; if (fy > sh - 1) fy = sh - 1;
      const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        let fx = x / f - 0.5; if (fx < 0) fx = 0; if (fx > sw - 1) fx = sw - 1;
        const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), ax = fx - x0;
        const t = bg[y0 * sw + x0] * (1 - ax) + bg[y0 * sw + x1] * ax, b = bg[y1 * sw + x0] * (1 - ax) + bg[y1 * sw + x1] * ax;
        out[y * w + x] = t * (1 - ay) + b * ay;
      }
    }
    return out;
  }

  function percentile(hist, total, p) {
    let acc = 0; const target = total * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  function applyFilter(canvas, name) {
    if (!name || name === 'original') return canvas;
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h), d = img.data, n = w * h;
    const lum = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;

    if (name === 'color') {
      // สีปกติ: แก้สมดุลแสง ให้กระดาษขาวขึ้นเล็กน้อย คงสีตามจริง
      const hs = [new Float64Array(256), new Float64Array(256), new Float64Array(256)], hl = new Float64Array(256);
      for (let i = 0, j = 0; i < n; i++, j += 4) { hs[0][d[j]]++; hs[1][d[j + 1]]++; hs[2][d[j + 2]]++; hl[lum[i] | 0]++; }
      const white = hs.map(hh => Math.max(60, percentile(hh, n, 0.96)));
      const black = Math.min(60, percentile(hl, n, 0.01));
      const gain = white.map(wv => Math.min(1.7, Math.max(1, 248 / wv)));
      for (let j = 0; j < d.length; j += 4) for (let c = 0; c < 3; c++) {
        let v = d[j + c] * gain[c];
        v = (v - black * 0.7) * 255 / (255 - black * 0.7);
        d[j + c] = clamp(v);
      }
    } else if (name === 'enhance' || name === 'gray') {
      // สีคมชัด / ขาวเทา: หารด้วยสีพื้นกระดาษเฉพาะจุด → ลบเงาและสีแสงไฟ ให้พื้นขาวสม่ำเสมอ
      const hs = [0, 1, 2].map(() => new Float64Array(256));
      for (let j = 0; j < d.length; j += 4) { hs[0][d[j]]++; hs[1][d[j + 1]]++; hs[2][d[j + 2]]++; }
      const chans = name === 'gray' ? [lum] : [0, 1, 2].map(c => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = d[i * 4 + c]; return a; });
      const bgs = chans.map((ch, c) => {
        const paper = name === 'gray' ? 230 : Math.max(80, percentile(hs[c], n, 0.95));
        return backgroundMap(ch, w, h, paper * 0.55);
      });
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        if (name === 'gray') {
          let v = lum[i] / bgs[0][i];
          v = clamp(255 * Math.pow(Math.min(1, v * 1.04), 1.8));
          d[j] = d[j + 1] = d[j + 2] = v;
        } else {
          const r = Math.min(1, chans[0][i] / bgs[0][i] * 1.03), g = Math.min(1, chans[1][i] / bgs[1][i] * 1.03), b2 = Math.min(1, chans[2][i] / bgs[2][i] * 1.03);
          const l = 0.299 * r + 0.587 * g + 0.114 * b2;
          const vals = [r, g, b2];
          for (let c = 0; c < 3; c++) {
            let v = l + (vals[c] - l) * 1.3;           // เพิ่มความอิ่มสี
            v = Math.pow(Math.min(1, Math.max(0, v)), 1.5); // ตัวหนังสือเข้ม พื้นขาว
            d[j + c] = clamp(v * 255);
          }
        }
      }
    } else if (name === 'bw') {
      // ขาวดำ: adaptive threshold
      const bg = localMean(lum, w, h, 0.035);
      const hl = new Float64Array(256); for (let i = 0; i < n; i++) hl[lum[i] | 0]++;
      const darkCut = percentile(hl, n, 0.95) * 0.42; // พื้นที่สีเข้มทึบ (เช่นตราประทับ) ให้เป็นสีดำ
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, j = i * 4;
        const v = lum[i] < bg(x, y) * 0.82 || lum[i] < darkCut ? 0 : 255;
        d[j] = d[j + 1] = d[j + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function rotate(canvas, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return canvas;
    const sw = deg % 180 !== 0;
    const c = makeCanvas(sw ? canvas.height : canvas.width, sw ? canvas.width : canvas.height);
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }

  function scaleTo(canvas, maxSide) {
    const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    if (s === 1) return canvas;
    const c = makeCanvas(canvas.width * s, canvas.height * s);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  function toBlob(canvas, q) {
    return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('สร้างภาพไม่ได้')), 'image/jpeg', q));
  }

  // ประมวลผลหน้า: ดัดตรง → ฟิลเตอร์ → หมุน
  async function render(srcCanvas, page) {
    let c = warp(srcCanvas, page.corners);
    applyFilter(c, page.filter);
    c = rotate(c, page.rotation || 0);
    return c;
  }

  window.Scan = { loadImage, detect, defaultCorners, fullCorners, warp, applyFilter, rotate, scaleTo, toBlob, render, makeCanvas };
})();
