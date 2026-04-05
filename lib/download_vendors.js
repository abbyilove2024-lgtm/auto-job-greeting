/**
 * download_vendors.js
 * 一次性脚本：下载 pdf.js / pdf.worker / mammoth 到 lib/vendor/
 * 运行：node lib/download_vendors.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const vendorDir = path.join(__dirname, 'vendor');
if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

const files = [
  {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    dest: path.join(vendorDir, 'pdf.min.js'),
  },
  {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    dest: path.join(vendorDir, 'pdf.worker.min.js'),
  },
  {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    dest: path.join(vendorDir, 'mammoth.browser.min.js'),
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const size = fs.statSync(dest).size;
        console.log(`✅ ${path.basename(dest)}  (${(size / 1024).toFixed(1)} KB)`);
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  console.log('📥 正在下载 vendor 库…');
  for (const f of files) {
    if (fs.existsSync(f.dest)) {
      const size = fs.statSync(f.dest).size;
      console.log(`⏭  跳过（已存在）${path.basename(f.dest)}  (${(size / 1024).toFixed(1)} KB)`);
      continue;
    }
    try {
      await download(f.url, f.dest);
    } catch (e) {
      console.error(`❌ 下载失败: ${f.url}\n   ${e.message}`);
    }
  }
  console.log('\n✨ 完成！vendor 文件已保存到 lib/vendor/');
})();
