const fs = require('fs');
const path = require('path');

const url = (process.env.BACKEND_URL || '').replace(/\/$/, '');
fs.writeFileSync(
  path.join(__dirname, '..', 'public', 'config.js'),
  `window.BACKEND_URL = ${JSON.stringify(url)};\n`
);
console.log('config.js written, BACKEND_URL =', url || '(same origin)');
