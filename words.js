/**
 * 传画接龙词库加载器
 * 支持多词库切换：读取 词库/ 目录下所有 【简体中文】xxx.txt 文件
 * 房主可在房间设置中选择词库
 */

const fs = require('fs');
const path = require('path');

const WORDS_DIR = path.join(__dirname, '词库');

// 当前词库名称和词语列表（可变，支持运行时切换）
let currentLibName = '默认';
let currentWords = [];

/**
 * 扫描可用的词库列表
 */
function scanWordLibraries() {
  if (!fs.existsSync(WORDS_DIR)) return [];
  return fs.readdirSync(WORDS_DIR)
    .filter(f => f.startsWith('【简体中文】') && f.endsWith('.txt'))
    .sort()
    .map(file => {
      const fullPath = path.join(WORDS_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const words = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const displayName = file.replace(/\.txt$/, '');
      return { name: displayName, file, count: words.length };
    });
}

/**
 * 从指定词库文件加载词语
 */
function loadWords(fileName) {
  const filePath = fileName
    ? path.join(WORDS_DIR, fileName.startsWith('【简体中文】') ? fileName : '【简体中文】' + fileName)
    : path.join(WORDS_DIR, '【简体中文】默认.txt');

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const words = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (words.length === 0) {
      console.warn(`[词库] 文件 ${filePath} 为空`);
      return getFallbackWords();
    }
    return words;
  } catch (err) {
    console.warn(`[词库] 无法读取 ${filePath}: ${err.message}`);
    return getFallbackWords();
  }
}

/**
 * 切换当前词库
 * @param {string} name - 词库显示名，如"默认"、"搞笑"、"大全"
 * @returns {boolean} 是否切换成功
 */
function setCurrentLib(name) {
  const libs = scanWordLibraries();
  const lib = libs.find(l => l.name === name);
  if (!lib) {
    console.warn(`[词库] 未找到词库 "${name}"`);
    return false;
  }
  const words = loadWords(lib.file);
  currentWords.length = 0;
  currentWords.push(...words);
  currentLibName = name;
  console.log(`[词库] 切换到 "${name}" (${words.length} 词)`);
  return true;
}

/**
 * 获取当前词库名称
 */
function getCurrentLibName() {
  return currentLibName;
}

/**
 * 内置备用词库
 */
function getFallbackWords() {
  return [
    "猫","狗","兔子","老虎","狮子","大象","熊猫","苹果","香蕉","西瓜",
    "太阳","月亮","星星","云","彩虹","花","树","跑步","游泳","跳舞",
    "唱歌","画画","医生","警察","老师","城堡","灯塔","金字塔","长城"
  ];
}

// 初始化：加载默认词库
const libraries = scanWordLibraries();
const defaultLib = libraries.find(l => l.name.includes('默认')) || libraries[0];
if (defaultLib) {
  const words = loadWords(defaultLib.file);
  currentWords.push(...words);
  currentLibName = defaultLib.name;
} else {
  currentWords.push(...getFallbackWords());
}

// 导出：currentWords 作为默认导出（数组）
module.exports = currentWords;
module.exports.loadWords = loadWords;
module.exports.scanWordLibraries = scanWordLibraries;
module.exports.getFallbackWords = getFallbackWords;
module.exports.libraries = libraries;
module.exports.setCurrentLib = setCurrentLib;
module.exports.getCurrentLibName = getCurrentLibName;
