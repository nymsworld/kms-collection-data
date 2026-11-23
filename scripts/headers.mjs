// Writes out/_headers and a small out/index.html for the data site: anyone may read the files (the app runs on
// collect.kantomisplay.cc and in the Android app at https://localhost), cached 5 minutes (sets.json says which
// nightly build is current, and the app asks for each build's files by its date).
import fs from 'node:fs';
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/_headers', [
  '/*',
  '  Access-Control-Allow-Origin: *',
  '  X-Content-Type-Options: nosniff',
  '  Cache-Control: public, max-age=300',
  ''
].join('\n'));
fs.writeFileSync('out/index.html', '<!doctype html><meta charset="utf-8"><title>KMS Collection data</title>' +
  '<p>Card data for <a href="https://collect.kantomisplay.cc">KMS Collection</a>, rebuilt nightly.</p>\n');
