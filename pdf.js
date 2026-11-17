/* pdf.js — เขียนไฟล์ PDF เองจากภาพ JPEG (ไม่ใช้ไลบรารีภายนอก ทำงานออฟไลน์) */
(function () {
  'use strict';

  const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
  const QUALITY = { low: { side: 1400, q: 0.55 }, mid: { side: 1900, q: 0.72 }, high: { side: 2480, q: 0.88 } };

  const enc = new TextEncoder();

  function utf16hex(s) {
    let h = 'FEFF';
    for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return '<' + h + '>';
  }
  const num = v => (Math.round(v * 100) / 100).toString();

  /**
   * pages: [{ jpeg: Uint8Array, w, h }]
   * opts: { paper: 'a4'|'letter'|'fit', title }
   */
  function build(pages, opts) {
    const chunks = []; let offset = 0; const offsets = [];
    const write = x => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); offset += b.length; };
    const obj = (id, body) => { offsets[id] = offset; write(id + ' 0 obj\n'); body(); write('\nendobj\n'); };

    write('%PDF-1.4\n');
    write(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const n = pages.length;
    // 1 catalog, 2 pages, 3 info, แต่ละหน้าใช้ 3 อ็อบเจกต์: page, content, image
    const pageId = i => 4 + i * 3;
    obj(1, () => write('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => write('<< /Type /Pages /Kids [' + pages.map((_, i) => pageId(i) + ' 0 R').join(' ') + '] /Count ' + n + ' >>'));
    obj(3, () => write('<< /Title ' + utf16hex(opts.title || 'scan') + ' /Producer (Offline Scanner PWA) >>'));

    pages.forEach((p, i) => {
      const landscape = p.w > p.h;
      let pw, ph;
      if (opts.paper === 'fit') {
        const long = PAPER.a4[1], s = long / Math.max(p.w, p.h);
        pw = p.w * s; ph = p.h * s;
      } else {
        [pw, ph] = PAPER[opts.paper] || PAPER.a4;
        if (landscape) [pw, ph] = [ph, pw];
      }
      const s = Math.min(pw / p.w, ph / p.h);
      const dw = p.w * s, dh = p.h * s, dx = (pw - dw) / 2, dy = (ph - dh) / 2;
      const id = pageId(i), cid = id + 1, iid = id + 2;
      const content = 'q ' + num(dw) + ' 0 0 ' + num(dh) + ' ' + num(dx) + ' ' + num(dy) + ' cm /Im0 Do Q';

      obj(id, () => write('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(pw) + ' ' + num(ph) + '] ' +
        '/Resources << /XObject << /Im0 ' + iid + ' 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ' + cid + ' 0 R >>'));
      obj(cid, () => { write('<< /Length ' + content.length + ' >>\nstream\n'); write(content); write('\nendstream'); });
      obj(iid, () => {
        write('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n');
        write(p.jpeg); write('\nendstream');
      });
    });

    const total = 4 + n * 3;
    const xref = offset;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    write(x);
    write('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  window.PDF = { build, QUALITY };
})();
