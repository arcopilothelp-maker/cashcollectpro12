// Reads a resume (PDF, DOCX or TXT) INSIDE the browser. The file itself is never uploaded:
// only the extracted text is sent to our server, which masks contact details before analysis.
(() => {
  const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
  const MAX_PAGES = 6;
  let pdfjsPromise, mammothPromise;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdf-4.10.38.min.js').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker-4.10.38.min.js';
        return lib;
      });
    }
    return pdfjsPromise;
  }

  function loadMammoth() {
    if (!mammothPromise) {
      mammothPromise = new Promise((resolve, reject) => {
        if (window.mammoth) return resolve(window.mammoth);
        const s = document.createElement('script');
        s.src = '/vendor/mammoth-1.13.0.min.js';
        s.onload = () => resolve(window.mammoth);
        s.onerror = () => reject(new Error('Could not load the Word reader.'));
        document.head.append(s);
      });
    }
    return mammothPromise;
  }

  async function fromPdf(buf) {
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true }).promise;
    const total = doc.numPages;
    const pages = Math.min(total, MAX_PAGES);
    const out = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '', lastY = null;
      for (const it of tc.items) {
        const y = it.transform ? Math.round(it.transform[5]) : lastY;
        if (lastY !== null && y !== lastY) { out.push(line.trim()); line = ''; }
        line += it.str + (it.hasEOL ? '\n' : ' ');
        lastY = y;
      }
      out.push(line.trim(), '');
    }
    await doc.destroy();
    return { text: out.join('\n'), pages: total };
  }

  async function fromDocx(buf) {
    const m = await loadMammoth();
    const r = await m.extractRawText({ arrayBuffer: buf });
    return { text: r.value, pages: null };
  }

  function tidy(t) {
    return String(t).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function extract(file) {
    if (!file) throw new Error('Please choose a file.');
    if (file.size > MAX_BYTES) throw new Error('File is larger than 5 MB. Please upload a smaller file.');
    const name = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    let r;
    if (name.endsWith('.pdf') || file.type === 'application/pdf') r = await fromPdf(buf);
    else if (name.endsWith('.docx')) r = await fromDocx(buf);
    else if (name.endsWith('.txt')) r = { text: new TextDecoder().decode(buf), pages: null };
    else if (name.endsWith('.doc')) throw new Error('Old .doc files cannot be read. Please save as .docx or PDF.');
    else throw new Error('Please upload a PDF, DOCX or TXT file.');
    const text = tidy(r.text);
    if (text.length < 300) {
      throw new Error(name.endsWith('.pdf')
        ? 'We could read almost no text. This looks like a scanned/image PDF, which most ATS also cannot read. That is your first fix: export the resume from Word/Google Docs as a text PDF.'
        : 'We could read almost no text from this file. Please paste your resume text instead.');
    }
    return { text, pages: r.pages, name: file.name };
  }

  window.CCPResume = { extract, tidy };
})();
