// prompt-seed.js — D-27 提示词生成器种子数据
//
// 设计：12 个模块 / 70 个标签 / 全部 ID 化
// 标签的"描述句子"暂不写，由 LLM 实时生成
// 启动时一次性 seed 进 db（KVDb，命名空间隔离）
'use strict';

// 12 个模块（id / 中文名 / 排序 / 描述）
const DEFAULT_PROMPT_MODULES = [
    { id: 'env',        name: '环境',    order: 1,  desc: '场景、场所、地点' },
    { id: 'light',      name: '光照',    order: 2,  desc: '光线类型、强度、时段' },
    { id: 'style',      name: '风格',    order: 3,  desc: '画面美术风格' },
    { id: 'subject',    name: '主体',    order: 4,  desc: '画面中的主要对象' },
    { id: 'character',  name: '人物',    order: 5,  desc: '人物身份、职业、年龄' },
    { id: 'body',       name: '身材',    order: 6,  desc: '体型、体态' },
    { id: 'hair',       name: '发型',    order: 7,  desc: '头发样式、长度' },
    { id: 'expression', name: '表情',    order: 8,  desc: '面部表情' },
    { id: 'clothing',   name: '服饰',    order: 9,  desc: '着装、装束' },
    { id: 'angle',      name: '视角',    order: 10, desc: '镜头角度、景别' },
    { id: 'tone',       name: '色调',    order: 11, desc: '整体色彩倾向' },
    { id: 'mood',       name: '氛围',    order: 12, desc: '情绪、意境、氛围' },
];

// 70 个标签（id / module / 中文名 / 排序 / desc）
const DEFAULT_PROMPT_TAGS = [
    // 环境 8
    { id: 'env:campus',  module: 'env', name: '校园',  order: 1, desc: '学校、操场、教学楼' },
    { id: 'env:street',  module: 'env', name: '街道',  order: 2, desc: '城市街道、街角、巷弄' },
    { id: 'env:cafe',    module: 'env', name: '咖啡馆', order: 3, desc: '室内咖啡店、吧台、桌椅' },
    { id: 'env:forest',  module: 'env', name: '山林',  order: 4, desc: '森林、树木、小径' },
    { id: 'env:beach',   module: 'env', name: '海边',  order: 5, desc: '沙滩、海浪、礁石' },
    { id: 'env:indoor',  module: 'env', name: '室内',  order: 6, desc: '室内空间、家居' },
    { id: 'env:ancient', module: 'env', name: '古镇',  order: 7, desc: '古风小镇、青砖瓦房' },
    { id: 'env:urban',   module: 'env', name: '都市',  order: 8, desc: '高楼林立、霓虹灯' },

    // 光照 6
    { id: 'light:warm_sun',   module: 'light', name: '暖阳',       order: 1, desc: '温暖的金色阳光' },
    { id: 'light:overcast',   module: 'light', name: '阴天',       order: 2, desc: '柔和散射光、灰调' },
    { id: 'light:night',      module: 'light', name: '夜景',       order: 3, desc: '月光、星空、夜晚' },
    { id: 'light:neon',       module: 'light', name: '霓虹',       order: 4, desc: '霓虹灯、彩光' },
    { id: 'light:backlight',  module: 'light', name: '逆光',       order: 5, desc: '从背后打来的光' },
    { id: 'light:golden',     module: 'light', name: '金色时刻',   order: 6, desc: '黄昏、日落时分' },

    // 风格 8
    { id: 'style:realistic',    module: 'style', name: '写实',     order: 1, desc: '照片级真实感' },
    { id: 'style:anime',        module: 'style', name: '动漫',     order: 2, desc: '日式动画风格' },
    { id: 'style:watercolor',   module: 'style', name: '水彩',     order: 3, desc: '水彩画风、晕染' },
    { id: 'style:oil',          module: 'style', name: '油画',     order: 4, desc: '油画质感、笔触' },
    { id: 'style:cyberpunk',    module: 'style', name: '赛博朋克', order: 5, desc: '赛博朋克风' },
    { id: 'style:ancient',      module: 'style', name: '古风',     order: 6, desc: '国风、传统美术' },
    { id: 'style:pixel',        module: 'style', name: '像素',     order: 7, desc: '像素艺术' },
    { id: 'style:3d',           module: 'style', name: '3D 渲染',  order: 8, desc: '三维 CGI 渲染' },

    // 主体 6
    { id: 'subject:single',     module: 'subject', name: '单人',       order: 1, desc: '一个人物' },
    { id: 'subject:couple',     module: 'subject', name: '双人对视',   order: 2, desc: '两人对视或互动' },
    { id: 'subject:group',      module: 'subject', name: '群体',       order: 3, desc: '多人场景' },
    { id: 'subject:none',       module: 'subject', name: '无人',       order: 4, desc: '空镜、风景为主' },
    { id: 'subject:animal',     module: 'subject', name: '动物',       order: 5, desc: '动物为主角' },
    { id: 'subject:object',     module: 'subject', name: '物品特写',   order: 6, desc: '物品、道具特写' },

    // 人物 8
    { id: 'char:student',       module: 'character', name: '学生',     order: 1, desc: '学生、青少年' },
    { id: 'char:teacher',       module: 'character', name: '教师',     order: 2, desc: '教师、知识分子' },
    { id: 'char:worker',        module: 'character', name: '职场人',   order: 3, desc: '白领、商务人士' },
    { id: 'char:swordsman',     module: 'character', name: '古风侠客', order: 4, desc: '古装侠客、剑客' },
    { id: 'char:rider',         module: 'character', name: '机车骑士', order: 5, desc: '摩托骑士、皮夹克' },
    { id: 'char:anime_girl',    module: 'character', name: '二次元少女', order: 6, desc: '动漫少女' },
    { id: 'char:mother',        module: 'character', name: '母亲',     order: 7, desc: '母亲、温柔' },
    { id: 'char:child',         module: 'character', name: '小孩',     order: 8, desc: '儿童、少年' },

    // 身材 4
    { id: 'body:slim',          module: 'body', name: '纤细', order: 1, desc: '纤细苗条' },
    { id: 'body:average',       module: 'body', name: '匀称', order: 2, desc: '标准匀称' },
    { id: 'body:muscular',      module: 'body', name: '健美', order: 3, desc: '肌肉健壮' },
    { id: 'body:plump',         module: 'body', name: '微胖', order: 4, desc: '丰满微胖' },

    // 发型 6
    { id: 'hair:long_straight', module: 'hair', name: '长直发', order: 1, desc: '又长又直的头发' },
    { id: 'hair:short',         module: 'hair', name: '短发',   order: 2, desc: '短发、齐耳' },
    { id: 'hair:twin_tail',     module: 'hair', name: '双马尾', order: 3, desc: '双马尾' },
    { id: 'hair:bun',           module: 'hair', name: '盘发',   order: 4, desc: '盘起来的发髻' },
    { id: 'hair:curly',         module: 'hair', name: '卷发',   order: 5, desc: '卷曲的头发' },
    { id: 'hair:bald',          module: 'hair', name: '光头',   order: 6, desc: '光头' },

    // 表情 4
    { id: 'expr:smile',         module: 'expression', name: '微笑', order: 1, desc: '微笑、浅笑' },
    { id: 'expr:gaze',          module: 'expression', name: '凝视', order: 2, desc: '凝视远方' },
    { id: 'expr:laugh',         module: 'expression', name: '大笑', order: 3, desc: '开怀大笑' },
    { id: 'expr:melancholy',    module: 'expression', name: '忧郁', order: 4, desc: '忧郁、沉思' },

    // 服饰 6
    { id: 'cloth:uniform',      module: 'clothing', name: '校服',   order: 1, desc: '学生校服' },
    { id: 'cloth:hanfu',        module: 'clothing', name: '汉服',   order: 2, desc: '传统汉服' },
    { id: 'cloth:suit',         module: 'clothing', name: '西装',   order: 3, desc: '正装西装' },
    { id: 'cloth:casual',       module: 'clothing', name: '休闲',   order: 4, desc: '休闲装' },
    { id: 'cloth:lolita',       module: 'clothing', name: '洛丽塔', order: 5, desc: '洛丽塔裙装' },
    { id: 'cloth:sport',        module: 'clothing', name: '运动',   order: 6, desc: '运动装' },

    // 视角 4
    { id: 'angle:eye',          module: 'angle', name: '平视', order: 1, desc: '平视视角' },
    { id: 'angle:low',          module: 'angle', name: '仰拍', order: 2, desc: '仰视、仰拍' },
    { id: 'angle:high',         module: 'angle', name: '俯拍', order: 3, desc: '俯视、俯拍' },
    { id: 'angle:closeup',      module: 'angle', name: '特写', order: 4, desc: '特写镜头' },

    // 色调 5
    { id: 'tone:warm',          module: 'tone', name: '暖黄',   order: 1, desc: '暖黄调' },
    { id: 'tone:cool',          module: 'tone', name: '冷蓝',   order: 2, desc: '冷蓝调' },
    { id: 'tone:pink',          module: 'tone', name: '粉紫',   order: 3, desc: '粉紫色调' },
    { id: 'tone:mono',          module: 'tone', name: '黑白',   order: 4, desc: '黑白单色' },
    { id: 'tone:morandy',       module: 'tone', name: '莫兰迪', order: 5, desc: '莫兰迪色' },

    // 氛围 5
    { id: 'mood:youth',         module: 'mood', name: '青春', order: 1, desc: '青春气息' },
    { id: 'mood:calm',          module: 'mood', name: '宁静', order: 2, desc: '宁静致远' },
    { id: 'mood:passion',       module: 'mood', name: '热血', order: 3, desc: '热血激情' },
    { id: 'mood:suspense',      module: 'mood', name: '悬疑', order: 4, desc: '悬疑紧张' },
    { id: 'mood:warm',          module: 'mood', name: '温馨', order: 5, desc: '温馨治愈' },
];

// 默认 LLM 配置（Ollama 本地）
const DEFAULT_LLM_CONFIG = {
    baseUrl: 'http://localhost:11434',
    model: '',  // 空 = 用户首次使用时从 Ollama 拉
    temperature: 0.7,
    systemPrompt: `你是一位专业的 AI 绘图提示词撰写专家，擅长将用户提供的标签组合转化为一段连贯、有画面感、细节丰富的详细提示词。

要求：
1. 不要简单拼接标签，而是要基于标签进行文学化扩写
2. 输出必须是**一段完整连贯的描述**，不是分段或列表
3. 必须包含时间、光影、色彩、氛围等画面细节
4. 字数控制在 150-300 字之间
5. 只输出最终的提示词本体，不要加任何解释、标题或前缀`,
};

module.exports = { DEFAULT_PROMPT_MODULES, DEFAULT_PROMPT_TAGS, DEFAULT_LLM_CONFIG };
