// 打包前确保 releases 目录存在（vsce 的 --out 指向不存在的路径时会把它当作文件名）
const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.join(__dirname, '..', 'releases'), { recursive: true });
