// 传画接龙词库加载器
// 从外部 words.txt 文件中读取词语，每行一个
// 替换 words.txt 即可自定义词库，无需修改代码

const fs = require('fs');
const path = require('path');

/**
 * 从指定路径读取词库文件
 * @param {string} [filePath] - 词库文件路径，默认为同目录下的 words.txt
 * @returns {string[]} 词语数组
 */
function loadWords(filePath) {
  const resolvedPath = filePath || path.join(__dirname, 'words.txt');
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const words = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    if (words.length === 0) {
      console.warn(`[词库] 文件 ${resolvedPath} 为空，使用内置备用词库`);
      return getFallbackWords();
    }
    return words;
  } catch (err) {
    console.warn(`[词库] 无法读取 ${resolvedPath}: ${err.message}，使用内置备用词库`);
    return getFallbackWords();
  }
}

/**
 * 内置备用词库 — 当外部文件无法读取时使用
 */
function getFallbackWords() {
  return [
    "猫", "狗", "兔子", "老虎", "狮子", "大象", "熊猫", "长颈鹿",
    "猴子", "蛇", "鱼", "鸟", "蝴蝶", "蜜蜂", "企鹅", "海豚",
    "苹果", "香蕉", "西瓜", "葡萄", "草莓", "芒果", "桃子", "梨",
    "汉堡", "薯条", "披萨", "面条", "饺子", "月饼", "粽子", "火锅",
    "雨伞", "手机", "眼镜", "手表", "钥匙", "钱包", "背包", "台灯",
    "太阳", "月亮", "星星", "云", "彩虹", "闪电", "雪花", "山",
    "跑步", "游泳", "跳舞", "唱歌", "画画", "弹琴", "打篮球", "踢足球",
    "医生", "警察", "老师", "画家", "厨师", "飞行员", "宇航员", "魔术师",
    "城堡", "灯塔", "金字塔", "长城", "寺庙", "风车", "摩天轮", "桥",
    "守株待兔", "画蛇添足", "亡羊补牢", "井底之蛙", "对牛弹琴",
    "画龙点睛", "一箭双雕", "春暖花开", "冰天雪地", "风和日丽",
    "机器人", "外星人", "恐龙", "独角兽", "飞碟", "海盗", "幽灵", "龙"
  ];
}

// 默认导出加载的词库
const wordList = loadWords();

module.exports = wordList;
// 同时导出工具方法，便于扩展
module.exports.loadWords = loadWords;
module.exports.getFallbackWords = getFallbackWords;
