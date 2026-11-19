/* 提示词字段数据（内嵌模式打包，file:// 下无法 fetch 本地 JSON） */
window.CPS_DATA = window.CPS_DATA || {};
window.CPS_DATA['data/models.json'] = {"version":1,"models":[]};
window.CPS_DATA['data/characters.json'] = {
  "version": 2,
  "module": "character",
  "title": "人物设定",
  "fields": [
    {
      "id": "age",
      "label": "年龄",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 24,
      "priority": 1,
      "hint": "0–14 与 62+ 区间模型出图质量明显下降（人物结构不稳）。24–30 是最稳的黄金区间。",
      "map": [
        {
          "from": 0,
          "to": 5,
          "tags": [
            "child",
            "toddler"
          ]
        },
        {
          "from": 6,
          "to": 11,
          "tags": [
            "child",
            "(child:1.1)"
          ]
        },
        {
          "from": 12,
          "to": 14,
          "tags": [
            "petite",
            "early teen",
            "(teen:1.05)"
          ]
        },
        {
          "from": 15,
          "to": 17,
          "tags": [
            "teen",
            "(teen:1.1)"
          ]
        },
        {
          "from": 18,
          "to": 22,
          "tags": [
            "young adult",
            "20 years old",
            "(aged up:1.05)"
          ]
        },
        {
          "from": 23,
          "to": 27,
          "tags": [
            "mature female",
            "24 years old"
          ]
        },
        {
          "from": 28,
          "to": 35,
          "tags": [
            "mature female",
            "(mature female:1.1)",
            "(aged up:1.1)"
          ]
        },
        {
          "from": 36,
          "to": 45,
          "tags": [
            "milf",
            "(mature female:1.2)",
            "(aged up:1.15)"
          ]
        },
        {
          "from": 46,
          "to": 55,
          "tags": [
            "milf",
            "(milf:1.2)",
            "(aged up:1.25)"
          ]
        },
        {
          "from": 56,
          "to": 70,
          "tags": [
            "old woman",
            "wrinkles",
            "(aged up:1.4)"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "old woman",
            "wrinkles",
            "grey hair",
            "(aged up:1.6)"
          ]
        }
      ],
      "danger": [
        [
          0,
          14
        ],
        [
          62,
          100
        ]
      ],
      "optional": false,
      "group": "face"
    },
    {
      "id": "race",
      "label": "人种",
      "type": "select",
      "optional": false,
      "priority": 2,
      "default": "east asian",
      "hint": "只保留洲级：写实模型对国家级词（日本/韩国）几乎无差别，对洲级（亚洲/欧洲/非洲）才稳定生效。\n「美洲/拉美」主要是脸型+发色倾向。选「不指定」就不写进提示词。",
      "options": [
        {
          "v": "east asian",
          "cn": "亚洲"
        },
        {
          "v": "caucasian",
          "cn": "欧洲"
        },
        {
          "v": "american",
          "cn": "美洲"
        },
        {
          "v": "latina",
          "cn": "拉美"
        },
        {
          "v": "african",
          "cn": "非洲"
        },
        {
          "v": "middle eastern",
          "cn": "中东"
        },
        {
          "v": "mixed race",
          "cn": "混血"
        },
        {
          "v": "none",
          "cn": "不指定"
        }
      ],
      "group": "race"
    },
    {
      "id": "beauty",
      "label": "颜值",
      "type": "slider",
      "optional": false,
      "priority": 3,
      "min": 0,
      "max": 100,
      "default": 100,
      "hint": "0–20 丑（不对称/平庸）、21–40 普通、41–60 清秀、61–80 漂亮、81–100 美若天仙（高权重 stunning/极美）。\n默认拉满；觉得太网红脸就往左拉。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "ugly",
            "ugly face",
            "(asymmetrical face:1.15)",
            "plain face",
            "unattractive"
          ]
        },
        {
          "from": 21,
          "to": 40,
          "tags": [
            "plain face",
            "average looking",
            "unremarkable face"
          ]
        },
        {
          "from": 41,
          "to": 60,
          "tags": [
            "pretty",
            "detailed face"
          ]
        },
        {
          "from": 61,
          "to": 80,
          "tags": [
            "beautiful",
            "gorgeous",
            "detailed face"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "(extremely beautiful:1.2)",
            "(detailed face:1.1)",
            "photogenic"
          ]
        }
      ],
      "group": "face"
    },
    {
      "id": "maturity",
      "label": "脸型成熟度",
      "type": "slider",
      "optional": true,
      "priority": 3,
      "hint": "",
      "default": null,
      "group": "face",
      "min": 0,
      "max": 100,
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "baby face",
            "round face",
            "(childlike:1.1)",
            "chubby cheeks"
          ]
        },
        {
          "from": 21,
          "to": 40,
          "tags": [
            "soft face",
            "youthful",
            "round face"
          ]
        },
        {
          "from": 41,
          "to": 60,
          "tags": [
            "soft face"
          ]
        },
        {
          "from": 61,
          "to": 80,
          "tags": [
            "mature face",
            "sharp cheekbones"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "mature face",
            "sharp cheekbones",
            "(mature female:1.2)",
            "long midface"
          ]
        }
      ]
    },
    {
      "id": "faceShape",
      "label": "脸型",
      "type": "select",
      "default": null,
      "priority": 4,
      "hint": "鹅蛋脸最稳；方脸/长脸在写实模型上容易显硬。",
      "options": [
        {
          "v": "oval face",
          "cn": "鹅蛋"
        },
        {
          "v": "round face",
          "cn": "圆脸"
        },
        {
          "v": "long face",
          "cn": "长脸"
        },
        {
          "v": "sharp chin",
          "cn": "瓜子"
        },
        {
          "v": "square face",
          "cn": "方脸"
        },
        {
          "v": "heart-shaped face",
          "cn": "心形脸"
        },
        {
          "v": "diamond face",
          "cn": "菱形脸"
        },
        {
          "v": "chubby face",
          "cn": "婴儿肥脸"
        },
        {
          "v": "thin face",
          "cn": "瘦削脸"
        },
        {
          "v": "wide face",
          "cn": "宽脸"
        },
        {
          "v": "small face",
          "cn": "小脸"
        },
        {
          "v": "(sharp jawline:1.1)",
          "cn": "下颌线明显"
        },
        {
          "v": "high cheekbones",
          "cn": "高颧骨"
        },
        {
          "v": "flat face",
          "cn": "扁平脸"
        },
        {
          "v": "sculpted jaw",
          "cn": "立体下颌"
        },
        {
          "v": "long midface",
          "cn": "中庭偏长"
        }
      ],
      "optional": true,
      "group": "face"
    },
    {
      "id": "eyeShape",
      "label": "眼型",
      "type": "multi",
      "default": [],
      "priority": 4,
      "hint": "上挑（tsurime）显得凌厉，下垂（tareme）显得柔弱。",
      "options": [
        {
          "v": "tsurime",
          "cn": "上挑"
        },
        {
          "v": "tareme",
          "cn": "下垂"
        },
        {
          "v": "round eyes",
          "cn": "圆眼"
        },
        {
          "v": "narrow eyes",
          "cn": "细长"
        },
        {
          "v": "cat eyes",
          "cn": "猫眼"
        },
        {
          "v": "half-closed eyes",
          "cn": "半睁"
        },
        {
          "v": "almond eyes",
          "cn": "杏眼"
        },
        {
          "v": "large eyes",
          "cn": "大眼"
        },
        {
          "v": "small eyes",
          "cn": "小眼"
        },
        {
          "v": "sharp eyes",
          "cn": "锐利眼"
        },
        {
          "v": "fox eyes",
          "cn": "狐狸眼"
        },
        {
          "v": "puppy eyes",
          "cn": "小狗眼"
        },
        {
          "v": "sleepy eyes",
          "cn": "惺忪眼"
        },
        {
          "v": "droopy eyes",
          "cn": "眼角下垂"
        },
        {
          "v": "wide-set eyes",
          "cn": "眼距宽"
        },
        {
          "v": "close-set eyes",
          "cn": "眼距窄"
        },
        {
          "v": "monolid",
          "cn": "单眼皮"
        },
        {
          "v": "double eyelid",
          "cn": "双眼皮"
        },
        {
          "v": "sanpaku eyes",
          "cn": "三白眼"
        },
        {
          "v": "hooded eyes",
          "cn": "内双"
        }
      ],
      "optional": true,
      "group": "face",
      "mergeFields": [
        "eyeColor",
        "pupilFx"
      ]
    },
    {
      "id": "eyeColor",
      "label": "瞳色",
      "type": "color",
      "default": null,
      "priority": 2,
      "hint": "异色瞳需要额外在「特征」里勾选。",
      "options": [
        {
          "v": "brown eyes",
          "cn": "棕",
          "hex": "#6b4a2a"
        },
        {
          "v": "black eyes",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "blue eyes",
          "cn": "蓝",
          "hex": "#3a6ea8"
        },
        {
          "v": "green eyes",
          "cn": "绿",
          "hex": "#3f7a4a"
        },
        {
          "v": "grey eyes",
          "cn": "灰",
          "hex": "#8a8a8a"
        },
        {
          "v": "red eyes",
          "cn": "红",
          "hex": "#a02a2a"
        },
        {
          "v": "purple eyes",
          "cn": "紫",
          "hex": "#7a4a9a"
        },
        {
          "v": "gold eyes",
          "cn": "金",
          "hex": "#c8a040"
        },
        {
          "v": "amber eyes",
          "cn": "琥珀",
          "hex": "#b07830"
        },
        {
          "v": "pink eyes",
          "cn": "粉",
          "hex": "#d87898"
        }
      ],
      "optional": true,
      "group": "face",
      "uiIn": "merge"
    },
    {
      "id": "pupilFx",
      "label": "瞳孔特效",
      "type": "multi",
      "group": "face",
      "uiIn": "merge",
      "optional": true,
      "priority": 3,
      "hint": "瞳孔形状/颜色特效，一般 1–2 个。",
      "options": [
        {
          "v": "heart-shaped pupils",
          "cn": "爱心瞳"
        },
        {
          "v": "star-shaped pupils",
          "cn": "星形瞳"
        },
        {
          "v": "slit pupils",
          "cn": "纵瞳"
        },
        {
          "v": "cross-shaped pupils",
          "cn": "十字瞳"
        },
        {
          "v": "heterochromia",
          "cn": "异色瞳"
        },
        {
          "v": "glowing eyes",
          "cn": "发光瞳"
        },
        {
          "v": "empty eyes",
          "cn": "空洞眼"
        },
        {
          "v": "spiral eyes",
          "cn": "螺旋眼"
        },
        {
          "v": "gradient eyes",
          "cn": "渐变瞳"
        },
        {
          "v": "colored sclera",
          "cn": "异色眼白"
        },
        {
          "v": "symbol-shaped pupils",
          "cn": "符号瞳"
        },
        {
          "v": "ringed eyes",
          "cn": "环纹眼"
        }
      ]
    },
    {
      "id": "mouth",
      "label": "嘴型",
      "type": "select",
      "default": null,
      "priority": 5,
      "hint": "厚唇配浓妆更有成人感。",
      "options": [
        {
          "v": "small mouth",
          "cn": "小嘴"
        },
        {
          "v": "thick lips",
          "cn": "厚唇"
        },
        {
          "v": "thin lips",
          "cn": "薄唇"
        },
        {
          "v": "parted lips",
          "cn": "微张"
        },
        {
          "v": "wide mouth",
          "cn": "大嘴"
        },
        {
          "v": "puffy lips",
          "cn": "嘟嘟唇"
        },
        {
          "v": "glossy lips",
          "cn": "亮泽唇"
        },
        {
          "v": "cupid bow lips",
          "cn": "爱神弓唇"
        },
        {
          "v": "dry lips",
          "cn": "干裂唇"
        },
        {
          "v": "(teeth:1.1)",
          "cn": "露齿"
        },
        {
          "v": "fang",
          "cn": "虎牙"
        },
        {
          "v": "lipstick",
          "cn": "口红"
        },
        {
          "v": "mole under mouth",
          "cn": "嘴角痣"
        },
        {
          "v": "upper teeth",
          "cn": "上齿"
        }
      ],
      "optional": true,
      "group": "face"
    },
    {
      "id": "makeup",
      "label": "妆容",
      "type": "multi",
      "default": [],
      "priority": 4,
      "hint": "妆容在写实模型上响应好；动漫模型基本只能看出唇色。",
      "options": [
        {
          "v": "makeup",
          "cn": "上妆"
        },
        {
          "v": "eyeliner",
          "cn": "眼线"
        },
        {
          "v": "eyeshadow",
          "cn": "眼影"
        },
        {
          "v": "mascara",
          "cn": "睫毛膏"
        },
        {
          "v": "false eyelashes",
          "cn": "假睫毛"
        },
        {
          "v": "lipstick",
          "cn": "口红"
        },
        {
          "v": "glossy lips",
          "cn": "亮泽唇"
        },
        {
          "v": "blush",
          "cn": "腮红"
        },
        {
          "v": "colored contacts",
          "cn": "美瞳"
        },
        {
          "v": "glitter",
          "cn": "闪粉"
        },
        {
          "v": "face paint",
          "cn": "面部彩绘"
        },
        {
          "v": "smokey eyes",
          "cn": "烟熏妆"
        },
        {
          "v": "natural makeup",
          "cn": "裸妆"
        },
        {
          "v": "heavy makeup",
          "cn": "浓妆"
        },
        {
          "v": "dramatic makeup",
          "cn": "舞台妆"
        },
        {
          "v": "eyebags",
          "cn": "黑眼圈"
        },
        {
          "v": "tear makeup",
          "cn": "泪痕妆"
        },
        {
          "v": "shiny lips",
          "cn": "水光唇"
        },
        {
          "v": "gradient lips",
          "cn": "渐变唇"
        },
        {
          "v": "pink lips",
          "cn": "粉唇"
        }
      ],
      "optional": true,
      "group": "face",
      "mergeField": "makeupInt"
    },
    {
      "id": "makeupInt",
      "label": "妆浓程度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 30,
      "priority": 5,
      "hint": "80+ 会盖掉面部细节。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "no makeup"
          ]
        },
        {
          "from": 26,
          "to": 60,
          "tags": [
            "light makeup"
          ]
        },
        {
          "from": 61,
          "to": 100,
          "tags": [
            "heavy makeup",
            "(makeup:1.2)"
          ]
        }
      ],
      "optional": true,
      "group": "face",
      "uiIn": "merge"
    },
    {
      "id": "mouthState",
      "label": "口部状态",
      "type": "select",
      "optional": true,
      "priority": 4,
      "hint": "",
      "options": [
        {
          "v": "closed mouth",
          "cn": "闭合"
        },
        {
          "v": "parted lips",
          "cn": "微张"
        },
        {
          "v": "open mouth",
          "cn": "张开"
        },
        {
          "v": "open mouth, wide open",
          "cn": "大张",
          "tags": [
            "open mouth",
            "(open mouth:1.2)",
            "wide open"
          ]
        },
        {
          "v": "tongue out",
          "cn": "吐舌"
        },
        {
          "v": "tongue",
          "cn": "舌头"
        },
        {
          "v": "teeth",
          "cn": "露齿"
        },
        {
          "v": "biting lip",
          "cn": "咬唇"
        },
        {
          "v": "licking lips",
          "cn": "舔唇"
        },
        {
          "v": "clenched teeth",
          "cn": "咬紧牙"
        },
        {
          "v": "panting",
          "cn": "喘气"
        },
        {
          "v": "open mouth, tongue",
          "cn": "张嘴伸舌"
        }
      ],
      "default": null,
      "group": "face",
      "uiIn": "pose"
    },
    {
      "id": "hairStyle",
      "label": "发型",
      "type": "multi",
      "default": [],
      "priority": 2,
      "hint": "最多叠 2 项，叠多了模型会糊。齐刘海 + 长直发是最稳组合。",
      "options": [
        {
          "v": "straight hair",
          "cn": "直发"
        },
        {
          "v": "long straight hair",
          "cn": "长直发"
        },
        {
          "v": "wavy hair",
          "cn": "波浪"
        },
        {
          "v": "curly hair",
          "cn": "卷发"
        },
        {
          "v": "twin tails",
          "cn": "双马尾"
        },
        {
          "v": "ponytail",
          "cn": "马尾"
        },
        {
          "v": "side ponytail",
          "cn": "侧马尾"
        },
        {
          "v": "braid",
          "cn": "麻花辫"
        },
        {
          "v": "bun",
          "cn": "丸子头"
        },
        {
          "v": "hime cut",
          "cn": "公主切"
        },
        {
          "v": "sidelocks",
          "cn": "侧发"
        },
        {
          "v": "ahoge",
          "cn": "呆毛"
        },
        {
          "v": "blunt bangs",
          "cn": "齐刘海"
        },
        {
          "v": "parted bangs",
          "cn": "侧分"
        },
        {
          "v": "hair intakes",
          "cn": "空气刘海"
        },
        {
          "v": "messy hair",
          "cn": "凌乱"
        },
        {
          "v": "wet hair",
          "cn": "湿发"
        },
        {
          "v": "hair up",
          "cn": "盘发"
        }
      ],
      "optional": true,
      "group": "hair"
    },
    {
      "id": "hairDetail",
      "label": "发型细节",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "hair",
      "default": [],
      "hint": "比上面的「发型」更细：绑法、刘海、质感。选 2–3 个最准。",
      "options": [
        {
          "v": "twintails",
          "cn": "双马尾"
        },
        {
          "v": "high twintails",
          "cn": "高双马尾"
        },
        {
          "v": "low twintails",
          "cn": "低双马尾"
        },
        {
          "v": "ponytail",
          "cn": "马尾"
        },
        {
          "v": "high ponytail",
          "cn": "高马尾"
        },
        {
          "v": "side ponytail",
          "cn": "侧马尾"
        },
        {
          "v": "braid",
          "cn": "麻花辫"
        },
        {
          "v": "single braid",
          "cn": "单辫"
        },
        {
          "v": "twin braids",
          "cn": "双辫"
        },
        {
          "v": "french braid",
          "cn": "法式编发"
        },
        {
          "v": "hair bun",
          "cn": "丸子头"
        },
        {
          "v": "double bun",
          "cn": "双丸子"
        },
        {
          "v": "odango",
          "cn": "团子头"
        },
        {
          "v": "ahoge",
          "cn": "呆毛"
        },
        {
          "v": "hair intakes",
          "cn": "内卷发"
        },
        {
          "v": "blunt bangs",
          "cn": "齐刘海"
        },
        {
          "v": "swept bangs",
          "cn": "斜刘海"
        },
        {
          "v": "parted bangs",
          "cn": "中分刘海"
        },
        {
          "v": "hair over one eye",
          "cn": "遮眼发"
        },
        {
          "v": "sidelocks",
          "cn": "鬓发"
        },
        {
          "v": "hime cut",
          "cn": "公主切"
        },
        {
          "v": "bob cut",
          "cn": "波波头"
        },
        {
          "v": "pixie cut",
          "cn": "精灵短发"
        },
        {
          "v": "very long hair",
          "cn": "超长发"
        },
        {
          "v": "long straight hair",
          "cn": "长直发"
        },
        {
          "v": "wavy hair",
          "cn": "波浪卷"
        },
        {
          "v": "curly hair",
          "cn": "卷发"
        },
        {
          "v": "drill hair",
          "cn": "钻头卷"
        },
        {
          "v": "twin drills",
          "cn": "双钻卷"
        },
        {
          "v": "gradient hair",
          "cn": "渐变发"
        },
        {
          "v": "colored inner hair",
          "cn": "内层染"
        },
        {
          "v": "streaked hair",
          "cn": "挑染"
        },
        {
          "v": "two-tone hair",
          "cn": "双色发"
        },
        {
          "v": "multicolored hair",
          "cn": "多色发"
        },
        {
          "v": "wolf cut",
          "cn": "狼尾"
        },
        {
          "v": "messy hair",
          "cn": "凌乱发"
        },
        {
          "v": "wet hair",
          "cn": "湿发"
        },
        {
          "v": "hair spread out",
          "cn": "散发"
        }
      ]
    },
    {
      "id": "hairColor",
      "label": "发色",
      "type": "color",
      "default": null,
      "priority": 2,
      "hint": "深色系在暖光下容易发棕，需要 (black hair:1.15) 压制。",
      "options": [
        {
          "v": "black hair",
          "cn": "黑",
          "hex": "#161616"
        },
        {
          "v": "brown hair",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "blonde hair",
          "cn": "金",
          "hex": "#d9b26a"
        },
        {
          "v": "silver hair",
          "cn": "银",
          "hex": "#c8ccd4"
        },
        {
          "v": "white hair",
          "cn": "白",
          "hex": "#f0f0f0"
        },
        {
          "v": "red hair",
          "cn": "红",
          "hex": "#a8342a"
        },
        {
          "v": "pink hair",
          "cn": "粉",
          "hex": "#e08aa8"
        },
        {
          "v": "purple hair",
          "cn": "紫",
          "hex": "#7a4a9a"
        },
        {
          "v": "blue hair",
          "cn": "蓝",
          "hex": "#3a5a9a"
        },
        {
          "v": "green hair",
          "cn": "绿",
          "hex": "#3f7a4a"
        },
        {
          "v": "orange hair",
          "cn": "橙",
          "hex": "#d47a30"
        },
        {
          "v": "grey hair",
          "cn": "灰",
          "hex": "#8a8a8a"
        }
      ],
      "optional": true,
      "group": "hair"
    },
    {
      "id": "height",
      "label": "身高",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 10,
      "priority": 4,
      "hint": "petite / 高挑。对全身像影响明显，半身像基本无感。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "petite",
            "short stature"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": [
            "average height"
          ]
        },
        {
          "from": 46,
          "to": 70,
          "tags": [
            "tall"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "tall",
            "(tall:1.15)",
            "long legs"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "legRatio",
      "label": "腿长占比",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 4,
      "hint": "61+ 会挂 long legs 加权，容易让模型把画面拉长变形，配全身镜头才用。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "short legs"
          ]
        },
        {
          "from": 26,
          "to": 50,
          "tags": []
        },
        {
          "from": 51,
          "to": 75,
          "tags": [
            "long legs",
            "(long legs:1.1)"
          ]
        },
        {
          "from": 76,
          "to": 100,
          "tags": [
            "long legs",
            "(long legs:1.25)",
            "leggy"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "bodyFat",
      "label": "体脂/肉感",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 30,
      "priority": 2,
      "hint": "0–8 极瘦，9–20 纤细有肉（推荐），21–40 匀称，61+ 出 plump/thicc。",
      "map": [
        {
          "from": 0,
          "to": 8,
          "tags": [
            "(skinny:1.15)",
            "(slender:1.1)",
            "thin",
            "flat stomach"
          ]
        },
        {
          "from": 9,
          "to": 20,
          "tags": [
            "(slim:1.15)",
            "slender",
            "soft body",
            "flat stomach"
          ]
        },
        {
          "from": 21,
          "to": 40,
          "tags": [
            "slim",
            "average build"
          ]
        },
        {
          "from": 41,
          "to": 60,
          "tags": [
            "average build",
            "soft body"
          ]
        },
        {
          "from": 61,
          "to": 80,
          "tags": [
            "plump",
            "soft body",
            "(thicc:1.05)"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "chubby",
            "plump",
            "(thicc:1.2)",
            "wide hips"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "bust",
      "label": "胸围",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 58,
      "priority": 1,
      "hint": "83+ 会挂 (huge breasts:1.25)。80 以上配大胸 LoRA 反而更稳。",
      "map": [
        {
          "from": 0,
          "to": 10,
          "tags": [
            "flat chest"
          ]
        },
        {
          "from": 11,
          "to": 25,
          "tags": [
            "small breasts"
          ]
        },
        {
          "from": 26,
          "to": 45,
          "tags": [
            "medium breasts"
          ]
        },
        {
          "from": 46,
          "to": 65,
          "tags": [
            "large breasts"
          ]
        },
        {
          "from": 66,
          "to": 82,
          "tags": [
            "large breasts",
            "huge breasts"
          ]
        },
        {
          "from": 83,
          "to": 100,
          "tags": [
            "huge breasts",
            "(huge breasts:1.25)"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "hips",
      "label": "臀围",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 52,
      "priority": 3,
      "hint": "与体脂联动；70+ 出 wide hips + big ass，常与 thicc 同现。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "flat ass",
            "narrow hips"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": [
            "average hips"
          ]
        },
        {
          "from": 46,
          "to": 70,
          "tags": [
            "round hips"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "wide hips",
            "big ass",
            "(thicc:1.15)"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "waist",
      "label": "腰部",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 12,
      "priority": 4,
      "hint": "低值纤细；高值软腹。后者配趴姿/跪姿更自然。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "(slender waist:1.15)",
            "(narrow waist:1.2)",
            "flat stomach"
          ]
        },
        {
          "from": 21,
          "to": 50,
          "tags": []
        },
        {
          "from": 51,
          "to": 80,
          "tags": [
            "soft belly"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "soft belly",
            "plump"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "muscle",
      "label": "肌肉线条",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 10,
      "priority": 5,
      "hint": "61+ 出 abs/toned。写实模型响应好，动漫模型基本无效。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "soft body"
          ]
        },
        {
          "from": 21,
          "to": 50,
          "tags": [
            "visible collarbone"
          ]
        },
        {
          "from": 51,
          "to": 75,
          "tags": [
            "toned",
            "toned stomach"
          ]
        },
        {
          "from": 76,
          "to": 100,
          "tags": [
            "abs",
            "muscular female",
            "(toned:1.15)"
          ]
        }
      ],
      "optional": false,
      "group": "body"
    },
    {
      "id": "skinTone",
      "label": "皮肤白皙度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": null,
      "priority": 2,
      "hint": "0 = 深色 → 100 = 瓷白。配合色温滑条（暖光会让深色皮肤发红）。",
      "map": [
        {
          "from": 0,
          "to": 15,
          "tags": [
            "dark skin",
            "dark-skinned female"
          ]
        },
        {
          "from": 16,
          "to": 30,
          "tags": [
            "dark skin",
            "tan"
          ]
        },
        {
          "from": 31,
          "to": 45,
          "tags": [
            "tan",
            "tanned skin"
          ]
        },
        {
          "from": 46,
          "to": 65,
          "tags": [
            "light skin"
          ]
        },
        {
          "from": 66,
          "to": 85,
          "tags": [
            "pale skin"
          ]
        },
        {
          "from": 86,
          "to": 100,
          "tags": [
            "pale skin",
            "(pale skin:1.2)",
            "porcelain skin"
          ]
        }
      ],
      "optional": true,
      "group": "skin"
    },
    {
      "id": "skinTexture",
      "label": "皮肤质感",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": null,
      "priority": 4,
      "hint": "0 哑光 → 100 油光/汗。81+ 会与「出汗」特征重复叠加，二者选一。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "matte skin"
          ]
        },
        {
          "from": 26,
          "to": 55,
          "tags": [
            "detailed skin"
          ]
        },
        {
          "from": 56,
          "to": 80,
          "tags": [
            "shiny skin"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "shiny skin",
            "sweat",
            "(shiny skin:1.2)"
          ]
        }
      ],
      "optional": true,
      "group": "skin"
    },
    {
      "id": "tanLines",
      "label": "晒痕",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 0,
      "optional": false,
      "hint": "默认关闭。写实模型经常自己长出晒痕/肤色分界，关着的时候会在负向里压制。\n想要就往上拉：30 左右是浅浅的比基尼印，70 以上很明显。",
      "map": [
        {
          "from": 0,
          "to": 0,
          "tags": []
        },
        {
          "from": 1,
          "to": 35,
          "tags": [
            "faint tan lines"
          ]
        },
        {
          "from": 36,
          "to": 70,
          "tags": [
            "tan lines"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "(tan lines:1.2)",
            "prominent tan lines"
          ]
        }
      ],
      "group": "skin"
    },
    {
      "id": "blemish",
      "label": "痣/雀斑密度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": null,
      "priority": 5,
      "hint": "数量随值递增；写实模型效果自然，动漫模型容易糊成脏点。",
      "map": [
        {
          "from": 0,
          "to": 5,
          "tags": []
        },
        {
          "from": 6,
          "to": 30,
          "tags": [
            "mole under eye"
          ]
        },
        {
          "from": 31,
          "to": 60,
          "tags": [
            "mole under eye",
            "mole on thigh"
          ]
        },
        {
          "from": 61,
          "to": 85,
          "tags": [
            "freckles",
            "mole"
          ]
        },
        {
          "from": 86,
          "to": 100,
          "tags": [
            "freckles",
            "(freckles:1.2)",
            "mole"
          ]
        }
      ],
      "optional": true,
      "group": "skin"
    },
    {
      "id": "extras",
      "label": "特殊体征",
      "type": "multi",
      "default": [],
      "priority": 5,
      "hint": "兽耳/角/翅膀会大幅改变构图，与「写实」画风冲突。",
      "options": [
        {
          "v": "cat ears",
          "cn": "猫耳"
        },
        {
          "v": "animal ears",
          "cn": "兽耳"
        },
        {
          "v": "horns",
          "cn": "角"
        },
        {
          "v": "elf ears",
          "cn": "精灵耳"
        },
        {
          "v": "tail",
          "cn": "尾巴"
        },
        {
          "v": "wings",
          "cn": "翅膀"
        },
        {
          "v": "halo",
          "cn": "光环"
        },
        {
          "v": "fang",
          "cn": "虎牙"
        },
        {
          "v": "glasses",
          "cn": "眼镜"
        },
        {
          "v": "dog ears",
          "cn": "狗耳"
        },
        {
          "v": "fox ears",
          "cn": "狐耳"
        },
        {
          "v": "wolf ears",
          "cn": "狼耳"
        },
        {
          "v": "rabbit ears",
          "cn": "兔耳"
        },
        {
          "v": "bear ears",
          "cn": "熊耳"
        },
        {
          "v": "animal ear fluff",
          "cn": "耳内绒毛"
        },
        {
          "v": "demon horns",
          "cn": "恶魔角"
        },
        {
          "v": "dragon horns",
          "cn": "龙角"
        },
        {
          "v": "curled horns",
          "cn": "卷角"
        },
        {
          "v": "angel wings",
          "cn": "天使翼"
        },
        {
          "v": "bat wings",
          "cn": "蝙蝠翼"
        },
        {
          "v": "feathered wings",
          "cn": "羽翼"
        },
        {
          "v": "demon wings",
          "cn": "恶魔翼"
        },
        {
          "v": "cat tail",
          "cn": "猫尾"
        },
        {
          "v": "fox tail",
          "cn": "狐尾"
        },
        {
          "v": "multiple tails",
          "cn": "多尾"
        },
        {
          "v": "pointy ears",
          "cn": "尖耳"
        },
        {
          "v": "fangs",
          "cn": "獠牙"
        },
        {
          "v": "scales",
          "cn": "鳞片"
        },
        {
          "v": "slime girl",
          "cn": "史莱姆娘"
        },
        {
          "v": "kemonomimi",
          "cn": "兽耳娘"
        }
      ],
      "optional": true,
      "group": "misc"
    },
    {
      "id": "hairLength",
      "label": "发长",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": null,
      "priority": 2,
      "hint": "0–15 光头/超短是废档（容易出秃头怪）；日常用 50–85。",
      "map": [
        {
          "from": 0,
          "to": 8,
          "tags": [
            "bald"
          ]
        },
        {
          "from": 9,
          "to": 20,
          "tags": [
            "very short hair",
            "pixie cut"
          ]
        },
        {
          "from": 21,
          "to": 40,
          "tags": [
            "short hair"
          ]
        },
        {
          "from": 41,
          "to": 60,
          "tags": [
            "medium hair",
            "bob cut"
          ]
        },
        {
          "from": 61,
          "to": 80,
          "tags": [
            "long hair"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "very long hair",
            "(long hair:1.2)"
          ]
        }
      ],
      "optional": true,
      "group": "hair"
    }
  ],
  "groups": [
    {
      "id": "race",
      "name": "人种",
      "note": "亚洲、欧美、非洲、地中海"
    },
    {
      "id": "face",
      "name": "脸部",
      "note": "长相、五官、年龄、妆容"
    },
    {
      "id": "hair",
      "name": "头发",
      "note": "发型、发色、发长"
    },
    {
      "id": "body",
      "name": "身材",
      "note": "身高、三围、体态"
    },
    {
      "id": "skin",
      "name": "皮肤",
      "note": "肤色、质感、晒痕、痣斑"
    },
    {
      "id": "misc",
      "name": "其他",
      "note": "特殊体征、额外特征"
    }
  ]
};
window.CPS_DATA['data/clothing.json'] = {
  "version": 1,
  "module": "clothing",
  "title": "服装设定",
  "fields": [
    {
      "id": "top",
      "label": "上装",
      "type": "multi",
      "default": [],
      "priority": 1,
      "hint": "选连衣裙后本项自动禁用。叠超过 2 件模型会糊。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "t-shirt",
          "cn": "T恤"
        },
        {
          "v": "shirt",
          "cn": "衬衫"
        },
        {
          "v": "blouse",
          "cn": "雪纺衫"
        },
        {
          "v": "sweater",
          "cn": "毛衣"
        },
        {
          "v": "hoodie",
          "cn": "卫衣"
        },
        {
          "v": "cardigan",
          "cn": "开衫"
        },
        {
          "v": "tank top",
          "cn": "背心"
        },
        {
          "v": "camisole",
          "cn": "吊带"
        },
        {
          "v": "tube top",
          "cn": "抹胸"
        },
        {
          "v": "crop top",
          "cn": "短上衣"
        },
        {
          "v": "off-shoulder top",
          "cn": "露肩"
        },
        {
          "v": "suit jacket",
          "cn": "西装外套"
        },
        {
          "v": "leather jacket",
          "cn": "皮夹克"
        },
        {
          "v": "sailor shirt",
          "cn": "水手服"
        },
        {
          "v": "school uniform",
          "cn": "JK制服"
        },
        {
          "v": "maid outfit",
          "cn": "女仆装"
        },
        {
          "v": "nurse outfit",
          "cn": "护士服"
        },
        {
          "v": "kimono",
          "cn": "和服"
        },
        {
          "v": "yukata",
          "cn": "浴衣"
        },
        {
          "v": "china dress top",
          "cn": "旗袍上身"
        },
        {
          "v": "bikini top",
          "cn": "比基尼上衣"
        },
        {
          "v": "bra",
          "cn": "胸罩"
        },
        {
          "v": "sports bra",
          "cn": "运动内衣"
        },
        {
          "v": "apron",
          "cn": "围裙"
        },
        {
          "v": "see-through shirt",
          "cn": "透明衫"
        },
        {
          "v": "turtleneck",
          "cn": "高领"
        },
        {
          "v": "corset",
          "cn": "束胸"
        }
      ],
      "group": "up"
    },
    {
      "id": "topColor",
      "label": "上装颜色",
      "type": "color",
      "optional": true,
      "priority": 4,
      "forField": "top",
      "hint": "跟随「上装」选中的第一件衣服，输出成 black shirt 这种组合词；上装为空或互斥被禁用时不输出。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ],
      "default": null,
      "group": "up"
    },
    {
      "id": "bottom",
      "label": "下装",
      "type": "multi",
      "default": [],
      "priority": 1,
      "hint": "选连衣裙或泳裤时，内裤自动隐藏（可强制显示）。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "skirt",
          "cn": "短裙"
        },
        {
          "v": "pleated skirt",
          "cn": "百褶裙"
        },
        {
          "v": "pencil skirt",
          "cn": "包臀裙"
        },
        {
          "v": "long skirt",
          "cn": "长裙"
        },
        {
          "v": "dress",
          "cn": "连衣裙"
        },
        {
          "v": "jeans",
          "cn": "牛仔裤"
        },
        {
          "v": "shorts",
          "cn": "短裤"
        },
        {
          "v": "hot pants",
          "cn": "热裤"
        },
        {
          "v": "sweatpants",
          "cn": "运动裤"
        },
        {
          "v": "leggings",
          "cn": "紧身裤"
        },
        {
          "v": "china dress",
          "cn": "旗袍"
        },
        {
          "v": "swim shorts",
          "cn": "泳裤"
        }
      ],
      "group": "down"
    },
    {
      "id": "bottomColor",
      "label": "下装颜色",
      "type": "color",
      "optional": true,
      "priority": 4,
      "forField": "bottom",
      "hint": "跟随「下装」第一件衣服，如 black skirt / blue jeans；下装为空时不输出。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ],
      "default": null,
      "group": "down"
    },
    {
      "id": "underTop",
      "label": "内衣上",
      "type": "multi",
      "default": [],
      "priority": 3,
      "hint": "有上装时默认不输出；勾「强制显示」才出 bra peek 类词。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "bra",
          "cn": "胸罩"
        },
        {
          "v": "lace bra",
          "cn": "蕾丝胸罩"
        },
        {
          "v": "triangle bra",
          "cn": "三角杯"
        },
        {
          "v": "sports bra",
          "cn": "运动内衣"
        },
        {
          "v": "strapless bra",
          "cn": "无肩带胸罩"
        },
        {
          "v": "bandeau",
          "cn": "抹胸式"
        },
        {
          "v": "bralette",
          "cn": "无钢圈内衣"
        },
        {
          "v": "push-up bra",
          "cn": "聚拢款"
        },
        {
          "v": "front-closure bra",
          "cn": "前扣款"
        },
        {
          "v": "see-through bra",
          "cn": "半透明"
        },
        {
          "v": "pasties",
          "cn": "乳贴"
        },
        {
          "v": "corset",
          "cn": "束身衣"
        }
      ],
      "optional": true,
      "group": "under"
    },
    {
      "id": "underBottom",
      "label": "内衣下",
      "type": "multi",
      "default": [],
      "priority": 3,
      "hint": "有下装时默认不输出。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "panties",
          "cn": "内裤"
        },
        {
          "v": "lace panties",
          "cn": "蕾丝内裤"
        },
        {
          "v": "thong",
          "cn": "丁字裤"
        },
        {
          "v": "string panties",
          "cn": "绳裤"
        },
        {
          "v": "g-string",
          "cn": "G 弦裤"
        },
        {
          "v": "boyshorts",
          "cn": "平角内裤"
        },
        {
          "v": "bloomers",
          "cn": "灯笼裤"
        },
        {
          "v": "side-tie panties",
          "cn": "侧系带"
        },
        {
          "v": "lowleg panties",
          "cn": "低腰"
        },
        {
          "v": "highleg panties",
          "cn": "高叉"
        },
        {
          "v": "frilled panties",
          "cn": "荷叶边"
        },
        {
          "v": "micro panties",
          "cn": "极小款"
        }
      ],
      "optional": true,
      "group": "under"
    },
    {
      "id": "legwear",
      "label": "袜",
      "type": "multi",
      "default": [],
      "priority": 2,
      "hint": "",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "thighhighs",
          "cn": "大腿袜"
        },
        {
          "v": "pantyhose",
          "cn": "连裤袜"
        },
        {
          "v": "kneehighs",
          "cn": "及膝袜"
        },
        {
          "v": "socks",
          "cn": "短袜"
        },
        {
          "v": "fishnet tights",
          "cn": "渔网袜"
        },
        {
          "v": "garter belt",
          "cn": "吊带袜"
        },
        {
          "v": "bandage",
          "cn": "绷带"
        },
        {
          "v": "barefoot",
          "cn": "赤足"
        },
        {
          "v": "shiny pantyhose",
          "cn": "油光丝袜"
        },
        {
          "v": "open-crotch pantyhose",
          "cn": "开档丝袜"
        },
        {
          "v": "flesh-colored tights",
          "cn": "光腿神器"
        },
        {
          "v": "rolled down thighhighs",
          "cn": "袜口卷边"
        },
        {
          "v": "toe socks",
          "cn": "五指袜"
        },
        {
          "v": "stirrup pantyhose",
          "cn": "踩脚袜"
        },
        {
          "v": "layered stockings",
          "cn": "丝里丝"
        },
        {
          "v": "torn stockings",
          "cn": "破损袜"
        },
        {
          "v": "zettai ryouiki",
          "cn": "绝对领域"
        },
        {
          "v": "thigh strap",
          "cn": "大腿绑带"
        },
        {
          "v": "garter straps",
          "cn": "吊带"
        },
        {
          "v": "sheer stockings",
          "cn": "透明丝袜"
        },
        {
          "v": "lace stockings",
          "cn": "蕾丝袜"
        },
        {
          "v": "striped pantyhose",
          "cn": "条纹连裤袜"
        },
        {
          "v": "opaque tights",
          "cn": "不透明打底裤"
        },
        {
          "v": "ankle socks",
          "cn": "脚踝袜"
        },
        {
          "v": "leg warmers",
          "cn": "腿套"
        },
        {
          "v": "loose socks",
          "cn": "堆堆袜"
        },
        {
          "v": "kneehigh socks",
          "cn": "及膝短袜"
        },
        {
          "v": "back-seam stockings",
          "cn": "背缝丝袜"
        },
        {
          "v": "patterned stockings",
          "cn": "花纹丝袜"
        },
        {
          "v": "wet pantyhose",
          "cn": "湿透丝袜"
        },
        {
          "v": "ripped pantyhose",
          "cn": "破洞连裤袜"
        }
      ],
      "optional": true,
      "group": "leg"
    },
    {
      "id": "legwearColor",
      "label": "袜/腿部颜色",
      "type": "color",
      "optional": true,
      "priority": 4,
      "forField": "legwear",
      "hint": "跟随「腿饰」第一件，如 white thighhighs；选 barefoot 时不输出。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ],
      "default": null,
      "group": "leg"
    },
    {
      "id": "legRing",
      "label": "腿环",
      "type": "multi",
      "group": "leg",
      "priority": 46,
      "hint": "大腿上的环带/吊带/绑带。可叠多个（比如铆钉带 + 链子）。\n和「袜」里的吊带袜不冲突：这里只管腿上的装饰带，袜款仍由「袜」决定。",
      "options": [
        {
          "v": "leg ring",
          "cn": "腿环"
        },
        {
          "v": "thigh ring",
          "cn": "大腿环"
        },
        {
          "v": "double thigh straps",
          "cn": "双圈大腿带"
        },
        {
          "v": "single thigh strap",
          "cn": "单圈大腿带"
        },
        {
          "v": "studded thigh strap",
          "cn": "铆钉大腿带"
        },
        {
          "v": "chain thigh strap",
          "cn": "链条腿环"
        },
        {
          "v": "leg ribbon",
          "cn": "腿部缎带"
        },
        {
          "v": "leg harness",
          "cn": "腿部束缚带"
        },
        {
          "v": "knee strap",
          "cn": "膝盖绑带"
        },
        {
          "v": "ankle strap",
          "cn": "脚踝绑带"
        },
        {
          "v": "garter straps with clips",
          "cn": "带夹吊袜扣"
        },
        {
          "v": "lace thigh strap",
          "cn": "蕾丝大腿带"
        }
      ]
    },
    {
      "id": "legRingColor",
      "label": "腿环颜色",
      "type": "color",
      "optional": true,
      "priority": 46,
      "forField": "legRing",
      "group": "leg",
      "hint": "跟随「腿环」第一件，如 black thigh strap。多个腿环时只给第一件上色。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ]
    },
    {
      "id": "shoes",
      "label": "鞋",
      "type": "multi",
      "default": [],
      "priority": 4,
      "hint": "全身像才有意义，半身像基本看不到。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "high heels",
          "cn": "高跟"
        },
        {
          "v": "stiletto heels",
          "cn": "细高跟"
        },
        {
          "v": "platform shoes",
          "cn": "厚底"
        },
        {
          "v": "boots",
          "cn": "长靴"
        },
        {
          "v": "ankle boots",
          "cn": "短靴"
        },
        {
          "v": "sandals",
          "cn": "凉鞋"
        },
        {
          "v": "leather shoes",
          "cn": "皮鞋"
        },
        {
          "v": "geta",
          "cn": "木屐"
        },
        {
          "v": "sneakers",
          "cn": "运动鞋"
        },
        {
          "v": "loafers",
          "cn": "乐福鞋"
        },
        {
          "v": "mary janes",
          "cn": "玛丽珍鞋"
        },
        {
          "v": "pumps",
          "cn": "单鞋"
        },
        {
          "v": "wedges",
          "cn": "坡跟"
        },
        {
          "v": "ballet flats",
          "cn": "芭蕾平底"
        },
        {
          "v": "knee boots",
          "cn": "及膝靴"
        },
        {
          "v": "thigh boots",
          "cn": "过膝长靴"
        },
        {
          "v": "platform boots",
          "cn": "厚底靴"
        },
        {
          "v": "ankle strap heels",
          "cn": "脚踝绑带高跟"
        },
        {
          "v": "slippers",
          "cn": "拖鞋"
        },
        {
          "v": "flip-flops",
          "cn": "人字拖"
        },
        {
          "v": "uwabaki",
          "cn": "室内鞋"
        },
        {
          "v": "gladiator sandals",
          "cn": "罗马凉鞋"
        },
        {
          "v": "cowboy boots",
          "cn": "西部靴"
        },
        {
          "v": "sock boots",
          "cn": "袜靴"
        }
      ],
      "optional": true,
      "group": "foot"
    },
    {
      "id": "shoesColor",
      "label": "鞋颜色",
      "type": "color",
      "optional": true,
      "priority": 4,
      "forField": "shoes",
      "hint": "跟随「鞋子」第一件，如 black high heels。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ],
      "default": null,
      "group": "foot"
    },
    {
      "id": "headwear",
      "label": "头饰",
      "type": "multi",
      "default": [],
      "priority": 4,
      "hint": "发夹/丝带影响小；头纱、护士帽会明显改整体气质。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "hair clip",
          "cn": "发夹"
        },
        {
          "v": "hairband",
          "cn": "发带"
        },
        {
          "v": "ribbon",
          "cn": "丝带"
        },
        {
          "v": "hat",
          "cn": "帽子"
        },
        {
          "v": "beret",
          "cn": "贝雷帽"
        },
        {
          "v": "nurse cap",
          "cn": "护士帽"
        },
        {
          "v": "veil",
          "cn": "头纱"
        },
        {
          "v": "flower crown",
          "cn": "花环"
        },
        {
          "v": "maid headdress",
          "cn": "女仆头饰"
        },
        {
          "v": "cat ears",
          "cn": "猫耳"
        },
        {
          "v": "hair ornament",
          "cn": "发饰"
        },
        {
          "v": "hair bow",
          "cn": "发结"
        },
        {
          "v": "flower",
          "cn": "花"
        },
        {
          "v": "flower in hair",
          "cn": "戴花"
        },
        {
          "v": "tiara",
          "cn": "小皇冠"
        },
        {
          "v": "crown",
          "cn": "王冠"
        },
        {
          "v": "headphones",
          "cn": "耳机"
        },
        {
          "v": "hair flower",
          "cn": "发间花"
        },
        {
          "v": "goggles on head",
          "cn": "头顶护目镜"
        },
        {
          "v": "witch hat",
          "cn": "女巫帽"
        },
        {
          "v": "santa hat",
          "cn": "圣诞帽"
        },
        {
          "v": "crown of thorns",
          "cn": "荆棘冠"
        }
      ],
      "optional": true,
      "group": "acc"
    },
    {
      "id": "accessory",
      "label": "配饰",
      "type": "multi",
      "default": [],
      "priority": 4,
      "hint": "项圈/牵引绳在「道具」里，不在这里。",
      "options": [
        {
          "v": "none",
          "cn": "无（不穿）"
        },
        {
          "v": "necklace",
          "cn": "项链"
        },
        {
          "v": "earrings",
          "cn": "耳环"
        },
        {
          "v": "choker",
          "cn": "项圈"
        },
        {
          "v": "bracelet",
          "cn": "手链"
        },
        {
          "v": "ring",
          "cn": "戒指"
        },
        {
          "v": "glasses",
          "cn": "眼镜"
        },
        {
          "v": "sunglasses",
          "cn": "墨镜"
        },
        {
          "v": "mask",
          "cn": "口罩"
        },
        {
          "v": "belt",
          "cn": "腰带"
        },
        {
          "v": "gloves",
          "cn": "手套"
        },
        {
          "v": "cape",
          "cn": "披风"
        },
        {
          "v": "full-face mask",
          "cn": "全覆盖面罩"
        },
        {
          "v": "lace gloves",
          "cn": "蕾丝手套"
        },
        {
          "v": "pasties",
          "cn": "乳贴"
        },
        {
          "v": "chastity belt",
          "cn": "贞操带"
        },
        {
          "v": "harness",
          "cn": "束缚带"
        },
        {
          "v": "leopard print",
          "cn": "豹纹"
        },
        {
          "v": "chain",
          "cn": "金属链条"
        },
        {
          "v": "collar",
          "cn": "颈圈"
        },
        {
          "v": "leash",
          "cn": "牵引绳"
        },
        {
          "v": "blindfold",
          "cn": "眼罩"
        },
        {
          "v": "body chain",
          "cn": "身体链"
        },
        {
          "v": "anklet",
          "cn": "脚链"
        },
        {
          "v": "round eyewear",
          "cn": "圆框眼镜"
        },
        {
          "v": "fingerless gloves",
          "cn": "露指手套"
        }
      ],
      "optional": true,
      "group": "acc"
    },
    {
      "id": "material",
      "label": "材质",
      "type": "multi",
      "default": [],
      "priority": 3,
      "hint": "latex/leather 会显著改变反光质感，写实模型响应最好。",
      "options": [
        {
          "v": "lace",
          "cn": "蕾丝"
        },
        {
          "v": "silk",
          "cn": "丝绸"
        },
        {
          "v": "cotton",
          "cn": "棉"
        },
        {
          "v": "leather",
          "cn": "皮革"
        },
        {
          "v": "latex",
          "cn": "乳胶"
        },
        {
          "v": "denim",
          "cn": "牛仔"
        },
        {
          "v": "transparent",
          "cn": "透明"
        },
        {
          "v": "sheer",
          "cn": "薄纱"
        }
      ],
      "optional": true,
      "group": "mat"
    },
    {
      "id": "coverage",
      "label": "服装完整度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 90,
      "priority": 1,
      "hint": "开源版只保留穿着完整度：0–100 越接近 100，提示词里越强调「衣着整齐、遮挡充分」。",
      "map": [
        {
          "from": 0,
          "to": 100,
          "tags": []
        }
      ],
      "optional": false,
      "group": "cov"
    },
    {
      "id": "damage",
      "label": "破损度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 0,
      "priority": 4,
      "hint": "70+ 与「湿透」同时拉高会词冲突，建议只留一项。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": []
        },
        {
          "from": 21,
          "to": 55,
          "tags": [
            "torn clothes"
          ]
        },
        {
          "from": 56,
          "to": 80,
          "tags": [
            "torn clothes",
            "(torn clothes:1.2)",
            "ripped"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "tattered clothes",
            "shredded clothes",
            "rags"
          ]
        }
      ],
      "optional": true,
      "group": "mat"
    },
    {
      "id": "wet",
      "label": "湿透度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 0,
      "priority": 3,
      "hint": "50+ 出 see-through，与「半透明材质」会叠加成完全透明。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": []
        },
        {
          "from": 21,
          "to": 50,
          "tags": [
            "wet clothes"
          ]
        },
        {
          "from": 51,
          "to": 80,
          "tags": [
            "wet clothes",
            "see-through",
            "(wet clothes:1.2)"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "soaking wet",
            "clinging clothes",
            "(wet:1.3)"
          ]
        }
      ],
      "optional": true,
      "group": "mat"
    },
    {
      "id": "clothState",
      "label": "服装状态",
      "type": "multi",
      "group": "mat",
      "priority": 5,
      "optional": true,
      "hint": "衣服「怎么穿在身上」的动态状态：被风吹起、滑落、敞开、半脱。和覆盖度不冲突。",
      "options": [
        {
          "v": "skirt lift",
          "cn": "裙子飘起"
        },
        {
          "v": "wind lift",
          "cn": "被风吹起"
        },
        {
          "v": "clothes lift",
          "cn": "衣摆撩起"
        },
        {
          "v": "clothes pull",
          "cn": "衣服被拉"
        },
        {
          "v": "slipping clothes",
          "cn": "衣服滑落"
        },
        {
          "v": "clothes down",
          "cn": "褪到一半"
        },
        {
          "v": "open shirt",
          "cn": "衬衫敞开"
        },
        {
          "v": "open jacket",
          "cn": "外套敞开"
        },
        {
          "v": "unbuttoned",
          "cn": "钮扣解开"
        },
        {
          "v": "zipper down",
          "cn": "拉链半开"
        },
        {
          "v": "strap down",
          "cn": "肩带滑落"
        },
        {
          "v": "cleavage",
          "cn": "乳沟"
        },
        {
          "v": "towel",
          "cn": "浴巾围裹"
        },
        {
          "v": "apron only",
          "cn": "只穿围裙"
        }
      ]
    },
    {
      "id": "costume",
      "label": "职业/制服套装",
      "type": "multi",
      "priority": 1,
      "optional": true,
      "group": "suit",
      "default": [],
      "hint": "整身套装。跟上面的「上装/下装」可以叠加，但套装本身就带完整造型，通常单独用就够。",
      "options": [
        {
          "v": "maid outfit",
          "cn": "女仆装"
        },
        {
          "v": "french maid",
          "cn": "法式女仆"
        },
        {
          "v": "maid headdress",
          "cn": "女仆头饰"
        },
        {
          "v": "nurse uniform",
          "cn": "护士服"
        },
        {
          "v": "nurse cap",
          "cn": "护士帽"
        },
        {
          "v": "office lady",
          "cn": "OL"
        },
        {
          "v": "business suit",
          "cn": "职业西装"
        },
        {
          "v": "pencil skirt suit",
          "cn": "包臀裙套装"
        },
        {
          "v": "teacher",
          "cn": "教师装"
        },
        {
          "v": "blazer",
          "cn": "西装外套"
        },
        {
          "v": "miko",
          "cn": "巫女服"
        },
        {
          "v": "hakama",
          "cn": "袴"
        },
        {
          "v": "kimono",
          "cn": "和服"
        },
        {
          "v": "yukata",
          "cn": "浴衣"
        },
        {
          "v": "obi",
          "cn": "和服腰带"
        },
        {
          "v": "nun habit",
          "cn": "修女服"
        },
        {
          "v": "rosary",
          "cn": "念珠"
        },
        {
          "v": "serafuku",
          "cn": "水手服"
        },
        {
          "v": "sailor collar",
          "cn": "水手领"
        },
        {
          "v": "school uniform",
          "cn": "校服"
        },
        {
          "v": "gym uniform",
          "cn": "运动服"
        },
        {
          "v": "buruma",
          "cn": "运动短裤"
        },
        {
          "v": "bloomers",
          "cn": "灯笼裤"
        },
        {
          "v": "cheerleader uniform",
          "cn": "啦啦队服"
        },
        {
          "v": "idol clothes",
          "cn": "偶像服"
        },
        {
          "v": "stage costume",
          "cn": "舞台装"
        },
        {
          "v": "flight attendant",
          "cn": "空姐"
        },
        {
          "v": "police uniform",
          "cn": "警服"
        },
        {
          "v": "military uniform",
          "cn": "军装"
        },
        {
          "v": "bunny girl",
          "cn": "兔女郎"
        },
        {
          "v": "leotard",
          "cn": "紧身衣"
        },
        {
          "v": "playboy bunny",
          "cn": "兔女郎装"
        },
        {
          "v": "wedding dress",
          "cn": "婚纱"
        },
        {
          "v": "evening gown",
          "cn": "晚礼服"
        },
        {
          "v": "pajamas",
          "cn": "睡衣"
        },
        {
          "v": "nightgown",
          "cn": "睡裙"
        },
        {
          "v": "apron",
          "cn": "围裙"
        },
        {
          "v": "witch hat",
          "cn": "女巫帽"
        },
        {
          "v": "witch costume",
          "cn": "女巫装"
        },
        {
          "v": "magical girl",
          "cn": "魔法少女"
        },
        {
          "v": "vampire costume",
          "cn": "吸血鬼装"
        },
        {
          "v": "sukumizu",
          "cn": "学校泳装"
        },
        {
          "v": "one-piece swimsuit",
          "cn": "连体泳衣"
        },
        {
          "v": "bikini",
          "cn": "比基尼"
        },
        {
          "v": "race queen",
          "cn": "赛车女郎"
        },
        {
          "v": "waitress",
          "cn": "女招待"
        },
        {
          "v": "kogal",
          "cn": "小恶魔JK"
        },
        {
          "v": "gyaru",
          "cn": "辣妹装"
        },
        {
          "v": "hoodie",
          "cn": "连帽卫衣"
        },
        {
          "v": "tracksuit",
          "cn": "运动套装"
        },
        {
          "v": "lab coat",
          "cn": "白大褂"
        },
        {
          "v": "reverse bunny",
          "cn": "逆兔女郎"
        },
        {
          "v": "hanfu",
          "cn": "汉服"
        },
        {
          "v": "chinese wedding dress",
          "cn": "秀禾服"
        },
        {
          "v": "sari",
          "cn": "纱丽"
        },
        {
          "v": "dirndl",
          "cn": "德式紧身裙"
        },
        {
          "v": "backless dress",
          "cn": "露背晚礼服"
        },
        {
          "v": "boyfriend shirt",
          "cn": "男友衬衫"
        },
        {
          "v": "open shirt",
          "cn": "衬衫半敞"
        },
        {
          "v": "leather pants",
          "cn": "紧身皮裤"
        },
        {
          "v": "yoga pants",
          "cn": "瑜伽裤"
        },
        {
          "v": "overalls",
          "cn": "背带裤"
        },
        {
          "v": "bike shorts",
          "cn": "骑行裤"
        },
        {
          "v": "micro skirt",
          "cn": "齐B短裙"
        },
        {
          "v": "a-line skirt",
          "cn": "A字裙"
        },
        {
          "v": "bodysuit",
          "cn": "连体紧身衣"
        },
        {
          "v": "leather bodysuit",
          "cn": "连体皮衣"
        },
        {
          "v": "latex",
          "cn": "乳胶衣"
        },
        {
          "v": "sling bikini",
          "cn": "弹弓内衣"
        },
        {
          "v": "micro bikini",
          "cn": "微型比基尼"
        },
        {
          "v": "ballet outfit",
          "cn": "芭蕾舞装"
        },
        {
          "v": "victorian nightgown",
          "cn": "维多利亚睡裙"
        },
        {
          "v": "silk nightgown",
          "cn": "真丝吊带睡裙"
        },
        {
          "v": "bathrobe",
          "cn": "浴袍"
        },
        {
          "v": "puffy skirt",
          "cn": "蓬蓬裙"
        },
        {
          "v": "mermaid skirt",
          "cn": "鱼尾裙"
        },
        {
          "v": "knit dress",
          "cn": "针织紧身长裙"
        },
        {
          "v": "lace dress",
          "cn": "蕾丝裙"
        },
        {
          "v": "sundress",
          "cn": "连衣裙"
        },
        {
          "v": "down jacket",
          "cn": "羽绒服"
        },
        {
          "v": "fur coat",
          "cn": "皮草"
        },
        {
          "v": "jumpsuit",
          "cn": "连体工装"
        },
        {
          "v": "kilt",
          "cn": "苏格兰短裙"
        },
        {
          "v": "oversized sleeves",
          "cn": "萌袖"
        },
        {
          "v": "santa costume",
          "cn": "圣诞服"
        },
        {
          "v": "jirai kei",
          "cn": "地雷系"
        },
        {
          "v": "dudou",
          "cn": "肚兜"
        },
        {
          "v": "fundoshi",
          "cn": "兜裆布"
        },
        {
          "v": "raincoat",
          "cn": "雨衣"
        },
        {
          "v": "vest",
          "cn": "马甲"
        },
        {
          "v": "bandage outfit",
          "cn": "绷带装"
        },
        {
          "v": "ribbon outfit",
          "cn": "礼品丝带"
        },
        {
          "v": "rope outfit",
          "cn": "绳衣"
        },
        {
          "v": "ghost costume",
          "cn": "幽灵服"
        },
        {
          "v": "kigurumi",
          "cn": "玩偶服"
        },
        {
          "v": "abdominal stretch",
          "cn": "露脐装"
        },
        {
          "v": "thigh boots",
          "cn": "过膝长靴"
        },
        {
          "v": "platform shoes",
          "cn": "增高鞋"
        },
        {
          "v": "extreme heels",
          "cn": "恨天高"
        },
        {
          "v": "loafers",
          "cn": "制服鞋"
        },
        {
          "v": "sandals",
          "cn": "凉鞋"
        },
        {
          "v": "fluffy slippers",
          "cn": "毛绒拖鞋"
        },
        {
          "v": "ninja",
          "cn": "女忍者"
        },
        {
          "v": "kunoichi",
          "cn": "女忍"
        },
        {
          "v": "knight",
          "cn": "女骑士"
        },
        {
          "v": "armor",
          "cn": "盔甲"
        },
        {
          "v": "warrior",
          "cn": "女战士"
        },
        {
          "v": "martial artist",
          "cn": "武术家"
        },
        {
          "v": "gi",
          "cn": "道服"
        },
        {
          "v": "assassin",
          "cn": "刺客"
        },
        {
          "v": "hunter",
          "cn": "猎人"
        },
        {
          "v": "archer",
          "cn": "弓箭手"
        },
        {
          "v": "dancer",
          "cn": "舞娘"
        },
        {
          "v": "belly dancer",
          "cn": "肚皮舞娘"
        },
        {
          "v": "news anchor",
          "cn": "主持人"
        },
        {
          "v": "judge",
          "cn": "法官"
        },
        {
          "v": "journalist",
          "cn": "记者"
        },
        {
          "v": "bodyguard",
          "cn": "保镖"
        },
        {
          "v": "security guard",
          "cn": "保安"
        },
        {
          "v": "flight attendant uniform",
          "cn": "空乘制服"
        },
        {
          "v": "car model",
          "cn": "车模"
        },
        {
          "v": "supermodel",
          "cn": "超模"
        },
        {
          "v": "miko outfit",
          "cn": "巫女装束"
        },
        {
          "v": "battle armor",
          "cn": "战斗装甲"
        },
        {
          "v": "mecha pilot suit",
          "cn": "机甲驾驶服"
        },
        {
          "v": "racing suit",
          "cn": "赛车服"
        },
        {
          "v": "wetsuit",
          "cn": "潜水服"
        }
      ]
    },
    {
      "id": "suitColor",
      "label": "套装颜色",
      "type": "color",
      "optional": true,
      "priority": 4,
      "forField": "costume",
      "hint": "跟随「套装」选中的第一套，输出成 white maid outfit 这种组合词；套装为空时不输出。",
      "options": [
        {
          "v": "white",
          "cn": "白",
          "hex": "#f2f2f2"
        },
        {
          "v": "black",
          "cn": "黑",
          "hex": "#141414"
        },
        {
          "v": "red",
          "cn": "红",
          "hex": "#b02a2a"
        },
        {
          "v": "blue",
          "cn": "蓝",
          "hex": "#2a5aa0"
        },
        {
          "v": "navy blue",
          "cn": "藏青",
          "hex": "#1d2b45"
        },
        {
          "v": "green",
          "cn": "绿",
          "hex": "#2f6a3a"
        },
        {
          "v": "yellow",
          "cn": "黄",
          "hex": "#d8c040"
        },
        {
          "v": "pink",
          "cn": "粉",
          "hex": "#d87a9a"
        },
        {
          "v": "purple",
          "cn": "紫",
          "hex": "#6a3a8a"
        },
        {
          "v": "brown",
          "cn": "棕",
          "hex": "#5a3a22"
        },
        {
          "v": "beige",
          "cn": "米",
          "hex": "#d6c7a8"
        },
        {
          "v": "grey",
          "cn": "灰",
          "hex": "#7a7a7a"
        },
        {
          "v": "silver",
          "cn": "银",
          "hex": "#b8bcc4"
        },
        {
          "v": "gold",
          "cn": "金",
          "hex": "#c8a040"
        }
      ],
      "default": null,
      "group": "suit"
    }
  ],
  "colors": [
    {
      "v": "white",
      "cn": "白",
      "hex": "#f2f2f2"
    },
    {
      "v": "black",
      "cn": "黑",
      "hex": "#141414"
    },
    {
      "v": "red",
      "cn": "红",
      "hex": "#b02a2a"
    },
    {
      "v": "blue",
      "cn": "蓝",
      "hex": "#2a5aa0"
    },
    {
      "v": "green",
      "cn": "绿",
      "hex": "#2f6a3a"
    },
    {
      "v": "yellow",
      "cn": "黄",
      "hex": "#d8c040"
    },
    {
      "v": "pink",
      "cn": "粉",
      "hex": "#d87a9a"
    },
    {
      "v": "purple",
      "cn": "紫",
      "hex": "#6a3a8a"
    },
    {
      "v": "brown",
      "cn": "棕",
      "hex": "#5a3a22"
    },
    {
      "v": "silver",
      "cn": "银",
      "hex": "#b8bcc4"
    },
    {
      "v": "gold",
      "cn": "金",
      "hex": "#c8a040"
    },
    {
      "v": "grey",
      "cn": "灰",
      "hex": "#7a7a7a"
    }
  ],
  "rules": [
    {
      "id": "dress",
      "label": "连衣裙屏蔽上下装",
      "if": {
        "field": "bottom",
        "includes": "dress"
      },
      "then": {
        "disable": [
          "top",
          "underTop"
        ],
        "only": {
          "field": "bottom",
          "keep": [
            "dress"
          ]
        }
      }
    },
    {
      "id": "china",
      "label": "旗袍屏蔽上下装",
      "if": {
        "field": "bottom",
        "includes": "china dress"
      },
      "then": {
        "disable": [
          "top",
          "underTop"
        ],
        "only": {
          "field": "bottom",
          "keep": [
            "china dress"
          ]
        }
      }
    },
    {
      "id": "pants",
      "label": "有下装时隐藏内裤",
      "if": {
        "field": "bottom",
        "notIncludes": "none",
        "notEmpty": true
      },
      "then": {
        "disable": [
          "underBottom"
        ]
      }
    },
    {
      "id": "topwear",
      "label": "有上装时不输出露胸词",
      "if": {
        "field": "top",
        "notEmpty": true
      },
      "then": {
        "clear": [
          "underTop"
        ]
      }
    },
    {
      "id": "barefoot",
      "label": "光脚屏蔽鞋子",
      "if": {
        "field": "legwear",
        "includes": "barefoot"
      },
      "then": {
        "clear": [
          "shoes"
        ],
        "disable": [
          "shoes"
        ]
      }
    },
    {
      "id": "swimwear",
      "label": "比基尼上装屏蔽内衣",
      "if": {
        "field": "top",
        "includes": "bikini top"
      },
      "then": {
        "clear": [
          "underTop"
        ],
        "disable": [
          "underTop"
        ]
      }
    },
    {
      "id": "swimbottom",
      "label": "泳裤屏蔽内裤",
      "if": {
        "field": "bottom",
        "includes": "swim shorts"
      },
      "then": {
        "clear": [
          "underBottom"
        ],
        "disable": [
          "underBottom"
        ]
      }
    }
  ],
  "groups": [
    {
      "id": "cov",
      "name": "服装覆盖度",
      "note": "穿着相关选项"
    },
    {
      "id": "suit",
      "name": "套装",
      "note": "整套穿搭、套装颜色"
    },
    {
      "id": "up",
      "name": "上身",
      "note": "上装款式、颜色"
    },
    {
      "id": "down",
      "name": "下身",
      "note": "下装款式、颜色"
    },
    {
      "id": "under",
      "name": "内衣",
      "note": "内衣上、内衣下、颜色"
    },
    {
      "id": "leg",
      "name": "腿部",
      "note": "袜子、腿套、腿环、颜色"
    },
    {
      "id": "foot",
      "name": "鞋",
      "note": "鞋款、鞋颜色"
    },
    {
      "id": "acc",
      "name": "配饰",
      "note": "头饰、配饰"
    },
    {
      "id": "mat",
      "name": "材质与状态",
      "note": "材质、破损、湿透"
    }
  ]
};
window.CPS_DATA['data/poses-light.json'] = {
  "version": 1,
  "module": "pose",
  "tier": "light",
  "title": "SFW · 单人 / 双人动作",
  "commonSliders": [
    {
      "id": "camDist",
      "label": "镜头距离",
      "min": 0,
      "max": 100,
      "default": 75,
      "hint": "0 极特写 / 25 脸部特写 / 50 上半身 / 75 七分身 / 100 全身。低于 40 时全身词会被压制。",
      "map": [
        {
          "from": 0,
          "to": 10,
          "tags": [
            "(extreme close-up:1.15)"
          ]
        },
        {
          "from": 11,
          "to": 25,
          "tags": [
            "(close-up:1.15)",
            "face focus"
          ]
        },
        {
          "from": 26,
          "to": 50,
          "tags": [
            "(upper body:1.15)"
          ]
        },
        {
          "from": 51,
          "to": 75,
          "tags": [
            "(cowboy shot:1.1)"
          ]
        },
        {
          "from": 76,
          "to": 100,
          "tags": [
            "(full body:1.3)",
            "(head to toe:1.2)",
            "feet visible",
            "standing full figure"
          ]
        }
      ]
    },
    {
      "id": "legSpread",
      "label": "腿张开度",
      "min": 0,
      "max": 100,
      "default": 40,
      "hint": "0–20 并腿 / 21–45 微开 / 46–70 张开 / 71–90 大开 / 91–100 极限并挂 legs up（容易把构图拉成抬腿）",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "legs together",
            "closed legs"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": []
        },
        {
          "from": 46,
          "to": 70,
          "tags": []
        },
        {
          "from": 71,
          "to": 90,
          "tags": [
            "M-shaped legs"
          ]
        },
        {
          "from": 91,
          "to": 100,
          "tags": [
            "legs up"
          ]
        }
      ]
    },
    {
      "id": "bodyLean",
      "label": "身体前倾",
      "min": 0,
      "max": 100,
      "default": 30,
      "hint": "按画面需要微调即可。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "leaning back",
            "arched back"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": []
        },
        {
          "from": 46,
          "to": 75,
          "tags": [
            "leaning forward"
          ]
        },
        {
          "from": 76,
          "to": 100,
          "tags": [
            "bent over",
            "(leaning forward:1.2)"
          ]
        }
      ]
    },
    {
      "id": "headAngle",
      "label": "头部角度",
      "min": 0,
      "max": 100,
      "default": 40,
      "hint": "按画面需要微调即可。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "head down",
            "looking down"
          ]
        },
        {
          "from": 21,
          "to": 50,
          "tags": []
        },
        {
          "from": 51,
          "to": 80,
          "tags": [
            "head tilted back",
            "looking up"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "head tilted back",
            "(head back:1.2)",
            "looking up"
          ]
        }
      ]
    },
    {
      "id": "camHeight",
      "label": "镜头高度",
      "min": -100,
      "max": 100,
      "default": 0,
      "hint": "-100 正俯视（鸟瞰），+100 正仰视（虫眼）。仰视显腿长但容易出怪脸。",
      "map": [
        {
          "from": -100,
          "to": -60,
          "tags": [
            "from above",
            "high angle",
            "bird's eye view"
          ]
        },
        {
          "from": -59,
          "to": -20,
          "tags": [
            "from above"
          ]
        },
        {
          "from": -19,
          "to": 19,
          "tags": []
        },
        {
          "from": 20,
          "to": 59,
          "tags": [
            "from below"
          ]
        },
        {
          "from": 60,
          "to": 100,
          "tags": [
            "from below",
            "worm's eye view",
            "(from below:1.15)"
          ]
        }
      ]
    },
    {
      "id": "bodyTilt",
      "label": "身体倾斜",
      "min": -100,
      "max": 100,
      "default": 0,
      "hint": "负值后仰、正值前倾。后背位里前倾更自然。",
      "map": [
        {
          "from": -100,
          "to": -40,
          "tags": [
            "leaning back",
            "arched back"
          ]
        },
        {
          "from": -39,
          "to": 39,
          "tags": []
        },
        {
          "from": 40,
          "to": 100,
          "tags": [
            "leaning forward",
            "bent over"
          ]
        }
      ]
    },
    {
      "id": "exprInt",
      "label": "表情强度",
      "min": 0,
      "max": 100,
      "default": 10,
      "hint": "按画面需要微调即可。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": []
        },
        {
          "from": 21,
          "to": 40,
          "tags": [
            "half-closed eyes",
            "blush"
          ]
        },
        {
          "from": 41,
          "to": 70,
          "tags": [
            "moaning",
            "open mouth",
            "(blush:1.1)"
          ]
        },
        {
          "from": 71,
          "to": 90,
          "tags": [
            "moaning",
            "open mouth",
            "heavy breathing"
          ]
        },
        {
          "from": 91,
          "to": 100,
          "tags": [
            "rolling eyes",
            "tongue out"
          ]
        }
      ]
    },
    {
      "id": "sweat",
      "label": "出汗/潮红",
      "min": 0,
      "max": 100,
      "default": 0,
      "hint": "与人物里的「皮肤质感」会叠加，两者同时拉满会出油光脸。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": []
        },
        {
          "from": 21,
          "to": 50,
          "tags": [
            "sweat"
          ]
        },
        {
          "from": 51,
          "to": 80,
          "tags": [
            "sweat",
            "sweat drop",
            "blush"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "sweat",
            "(sweat:1.2)",
            "full-face blush",
            "wet skin"
          ]
        }
      ]
    },
    {
      "id": "clothesRemain",
      "label": "衣物残留",
      "min": 0,
      "max": 100,
      "default": 85,
      "hint": "反向联动服装覆盖度：0 = 全脱，100 = 完整。调这里不会改服装模块的设定，只影响姿势层的描述。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": []
        },
        {
          "from": 21,
          "to": 45,
          "tags": [
            "clothes lift"
          ]
        },
        {
          "from": 46,
          "to": 70,
          "tags": [
            "partially undressed",
            "panties pulled aside"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": []
        }
      ]
    }
  ],
  "poses": [
    {
      "id": "L01",
      "cn": "正面站姿",
      "tags": [
        "standing",
        "facing viewer",
        "arms at sides"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L02",
      "cn": "侧身回眸",
      "tags": [
        "looking back",
        "from side",
        "over shoulder",
        "turning head"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L03",
      "cn": "坐姿交腿",
      "tags": [
        "sitting",
        "crossed legs",
        "on chair"
      ],
      "sliders": [
        {
          "id": "crossAmt",
          "label": "交叠度",
          "min": 0,
          "max": 100,
          "default": 60,
          "map": [
            {
              "from": 0,
              "to": 40,
              "tags": [
                "legs together"
              ]
            },
            {
              "from": 41,
              "to": 70,
              "tags": [
                "crossed legs"
              ]
            },
            {
              "from": 71,
              "to": 100,
              "tags": [
                "crossed legs",
                "(crossed legs:1.15)"
              ]
            }
          ]
        }
      ],
      "group": "si",
      "hint": "椅子结构易崩：负向加 extra legs",
      "hintAuto": true
    },
    {
      "id": "L04",
      "cn": "蹲姿抱膝",
      "tags": [
        "squatting",
        "knees up",
        "hugging own legs",
        "arms around knees"
      ],
      "group": "si",
      "hint": "蹲姿腿会变形：负向加 deformed legs",
      "hintAuto": true
    },
    {
      "id": "L05",
      "cn": "跪坐",
      "tags": [
        "wariza",
        "sitting on heels",
        "kneeling"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L06",
      "cn": "仰卧伸展",
      "tags": [
        "lying",
        "on back",
        "arms above head",
        "on bed"
      ],
      "group": "si",
      "hint": "仰卧注意透视压缩：机位 45° 俯拍更准",
      "hintAuto": true
    },
    {
      "id": "L07",
      "cn": "侧卧支撑",
      "tags": [
        "lying on side",
        "propped up",
        "one arm supporting"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L08",
      "cn": "倚墙",
      "tags": [
        "leaning against wall",
        "one hand on wall",
        "leaning back",
        "standing"
      ],
      "sliders": [
        {
          "id": "leanAmt",
          "label": "倾身度",
          "min": 0,
          "max": 100,
          "default": 40,
          "map": [
            {
              "from": 0,
              "to": 40,
              "tags": [
                "leaning against wall"
              ]
            },
            {
              "from": 41,
              "to": 100,
              "tags": [
                "leaning against wall",
                "(leaning forward:1.2)"
              ]
            }
          ]
        }
      ],
      "group": "sg",
      "hint": "贴墙姿势身体会压扁：负向加 flat body",
      "hintAuto": true
    },
    {
      "id": "L09",
      "cn": "撩发",
      "tags": [
        "hand in own hair",
        "hair flip",
        "one hand up"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L10",
      "cn": "托腮",
      "tags": [
        "head rest",
        "hand on own cheek",
        "elbows on table"
      ],
      "group": "cl",
      "hint": "桌面会挡腿：机位略高，距离 50–70",
      "hintAuto": true
    },
    {
      "id": "L11",
      "cn": "自拍",
      "tags": [
        "selfie",
        "arm extended",
        "from above",
        "looking at viewer",
        "holding phone",
        "smartphone"
      ],
      "group": "sg",
      "hint": "自拍手机易变形：镜头距离 40–55，手部负向加 extra fingers",
      "hard": "手部+屏幕",
      "hintAuto": true
    },
    {
      "id": "L12",
      "cn": "背影",
      "tags": [
        "from behind",
        "back view",
        "looking over shoulder"
      ],
      "group": "sg",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "L14",
      "cn": "双手抱胸",
      "tags": [
        "standing",
        "arms crossed",
        "facing viewer",
        "confident pose"
      ],
      "group": "sg",
      "hint": "抱胸手臂会融合：负向加 fused arms",
      "hintAuto": true
    },
    {
      "id": "L15",
      "cn": "单手叉腰",
      "tags": [
        "standing",
        "hand on hip",
        "contrapposto",
        "facing viewer"
      ],
      "group": "sg",
      "hint": "叉腰手肘角度易崩：步数 28+",
      "hintAuto": true
    },
    {
      "id": "L16",
      "cn": "双手背后",
      "tags": [
        "standing",
        "arms behind back",
        "facing viewer",
        "head tilt"
      ],
      "group": "sg",
      "hint": "手在背后看不见：别指望手部细节",
      "hintAuto": true
    },
    {
      "id": "L17",
      "cn": "回眸站姿",
      "tags": [
        "standing",
        "looking back",
        "from behind",
        "over shoulder"
      ],
      "group": "sg",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "L18",
      "cn": "靠墙翘腿",
      "tags": [
        "leaning against wall",
        "standing",
        "legs crossed",
        "arms crossed"
      ],
      "group": "sg",
      "hint": "贴墙姿势身体会压扁：负向加 flat body",
      "hintAuto": true
    },
    {
      "id": "L19",
      "cn": "伸懒腰",
      "tags": [
        "standing",
        "stretching",
        "arms up",
        "eyes closed"
      ],
      "group": "sg",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L20",
      "cn": "侧身点地",
      "tags": [
        "standing",
        "side view",
        "one leg forward",
        "looking away"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L21",
      "cn": "交叉腿站姿",
      "tags": [
        "standing",
        "crossed legs",
        "arms behind back",
        "facing viewer"
      ],
      "group": "sg",
      "hint": "手在背后看不见：别指望手部细节",
      "hintAuto": true
    },
    {
      "id": "L22",
      "cn": "沙发盘腿",
      "tags": [
        "sitting",
        "on sofa",
        "indian style",
        "hands on lap"
      ],
      "group": "si",
      "hint": "沙发靠背易穿模：距离 50–65，别用大特写",
      "hintAuto": true
    },
    {
      "id": "L23",
      "cn": "俯卧翘腿",
      "tags": [
        "lying on stomach",
        "on bed",
        "legs up",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L24",
      "cn": "侧坐曲腿",
      "tags": [
        "sitting",
        "side view",
        "knees up",
        "arms around knees"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L25",
      "cn": "抱枕坐床",
      "tags": [
        "sitting on bed",
        "hugging pillow",
        "knees up",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L26",
      "cn": "仰卧屈膝",
      "tags": [
        "lying on back",
        "knees up",
        "arms above head",
        "on bed"
      ],
      "group": "si",
      "hint": "仰卧注意透视压缩：机位 45° 俯拍更准",
      "hintAuto": true
    },
    {
      "id": "L27",
      "cn": "侧躺抬腿",
      "tags": [
        "lying on side",
        "one leg raised",
        "head resting on arm"
      ],
      "group": "si",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hintAuto": true
    },
    {
      "id": "L28",
      "cn": "上半身特写",
      "tags": [
        "portrait",
        "upper body",
        "hands near face",
        "looking at viewer"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L29",
      "cn": "托腮特写",
      "tags": [
        "close-up",
        "chin resting on hand",
        "looking at viewer",
        "soft smile"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L30",
      "cn": "回首特写",
      "tags": [
        "close-up",
        "looking back",
        "face focus",
        "profile"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L31",
      "cn": "咬唇特写",
      "tags": [
        "close-up",
        "biting lip",
        "looking at viewer",
        "blush"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L32",
      "cn": "侧脸特写",
      "tags": [
        "close-up",
        "profile",
        "side view",
        "eyes closed"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L33",
      "cn": "低头垂眼",
      "tags": [
        "close-up",
        "looking down",
        "head down",
        "melancholic"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L34",
      "cn": "手抚胸口",
      "tags": [
        "standing",
        "hand on own chest",
        "looking at viewer",
        "soft expression"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L35",
      "cn": "双手举过头",
      "tags": [
        "standing",
        "arms overhead",
        "stretching",
        "eyes closed"
      ],
      "group": "sg",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L36",
      "cn": "双手交握",
      "tags": [
        "standing",
        "hands clasped",
        "facing viewer",
        "gentle smile"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L37",
      "cn": "手插口袋",
      "tags": [
        "standing",
        "hand in pocket",
        "casual",
        "looking away"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L38",
      "cn": "倚栏远望",
      "tags": [
        "standing",
        "leaning on railing",
        "looking away",
        "outdoors"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L39",
      "cn": "单腿站立",
      "tags": [
        "standing",
        "standing on one leg",
        "balance",
        "arms out"
      ],
      "group": "sg",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hintAuto": true
    },
    {
      "id": "L40",
      "cn": "弓背后仰",
      "tags": [
        "standing",
        "arched back",
        "head back",
        "hands on lower back"
      ],
      "group": "sg",
      "hint": "弓身会拉长躯干：负向加 long torso",
      "hintAuto": true
    },
    {
      "id": "L41",
      "cn": "挺胸站姿",
      "tags": [
        "standing",
        "shoulders back",
        "confident",
        "facing viewer"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L42",
      "cn": "回头望",
      "tags": [
        "standing",
        "looking over shoulder",
        "three-quarter view",
        "over shoulder"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L43",
      "cn": "双手拢发",
      "tags": [
        "standing",
        "hands in hair",
        "looking at viewer",
        "wind"
      ],
      "group": "sg",
      "hint": "手指插进头发易糊：机位偏侧面",
      "hintAuto": true
    },
    {
      "id": "L44",
      "cn": "张开双臂",
      "tags": [
        "standing",
        "arms outstretched",
        "eyes closed",
        "wind"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L45",
      "cn": "撑伞站立",
      "tags": [
        "standing",
        "holding umbrella",
        "rain",
        "side view"
      ],
      "group": "sg",
      "hint": "伞骨易乱：负向加 extra umbrella",
      "hintAuto": true
    },
    {
      "id": "L46",
      "cn": "手提包站立",
      "tags": [
        "standing",
        "holding bag",
        "fashion pose",
        "facing viewer"
      ],
      "group": "sg",
      "hint": "手持小物件易变形：距离 40–55",
      "hintAuto": true
    },
    {
      "id": "L47",
      "cn": "手持书",
      "tags": [
        "standing",
        "holding book",
        "looking down",
        "reading"
      ],
      "group": "sg",
      "hint": "手持小物件易变形：距离 40–55",
      "hintAuto": true
    },
    {
      "id": "L48",
      "cn": "手持花",
      "tags": [
        "standing",
        "holding flower",
        "looking at flower",
        "soft smile"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L49",
      "cn": "双手抱头",
      "tags": [
        "standing",
        "arms behind head",
        "facing viewer",
        "smirk"
      ],
      "group": "sg",
      "hint": "全身竖构图 9:16，镜头距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L50",
      "cn": "盘腿坐地",
      "tags": [
        "sitting on floor",
        "indian style",
        "hands on knees",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L51",
      "cn": "侧坐椅子",
      "tags": [
        "sitting on chair",
        "side view",
        "legs crossed",
        "hand on chair back"
      ],
      "group": "si",
      "hint": "椅子结构易崩：负向加 extra legs",
      "hintAuto": true
    },
    {
      "id": "L52",
      "cn": "坐窗台",
      "tags": [
        "sitting on windowsill",
        "looking out window",
        "knees up"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L53",
      "cn": "坐在台阶",
      "tags": [
        "sitting on stairs",
        "elbows on knees",
        "looking down"
      ],
      "group": "si",
      "hint": "阶梯线条乱：机位略低，距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L54",
      "cn": "反坐椅子",
      "tags": [
        "sitting backwards on chair",
        "arms on chair back",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "椅子结构易崩：负向加 extra legs",
      "hintAuto": true
    },
    {
      "id": "L55",
      "cn": "抱膝坐",
      "tags": [
        "sitting",
        "hugging own knees",
        "head on knees",
        "curled up"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L56",
      "cn": "趴着看书",
      "tags": [
        "lying on stomach",
        "reading book",
        "legs up",
        "on bed"
      ],
      "group": "si",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L57",
      "cn": "仰卧交腿",
      "tags": [
        "lying on back",
        "crossed legs",
        "arms behind head",
        "on bed"
      ],
      "group": "si",
      "hint": "仰卧注意透视压缩：机位 45° 俯拍更准",
      "hintAuto": true
    },
    {
      "id": "L58",
      "cn": "侧撑躺姿",
      "tags": [
        "lying on side",
        "propped up on elbow",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L59",
      "cn": "垂腿而坐",
      "tags": [
        "sitting",
        "legs dangling",
        "on ledge",
        "looking down"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L60",
      "cn": "正跪坐",
      "tags": [
        "kneeling",
        "seiza",
        "hands on lap",
        "upright"
      ],
      "group": "si",
      "hint": "坐卧类建议 3:4，距离 40–60",
      "hintAuto": true
    },
    {
      "id": "L61",
      "cn": "床沿而坐",
      "tags": [
        "sitting on bed",
        "feet on floor",
        "hands on bed",
        "looking at viewer"
      ],
      "group": "si",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L62",
      "cn": "蜷缩入睡",
      "tags": [
        "sleeping",
        "curled up",
        "lying on side",
        "on bed"
      ],
      "group": "si",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L63",
      "cn": "靠着沙发坐",
      "tags": [
        "sitting on sofa",
        "leaning back",
        "arm on backrest",
        "relaxed"
      ],
      "group": "si",
      "hint": "沙发靠背易穿模：距离 50–65，别用大特写",
      "hintAuto": true
    },
    {
      "id": "L64",
      "cn": "向前走",
      "tags": [
        "walking",
        "mid-stride",
        "facing viewer",
        "swinging arms"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L65",
      "cn": "向前跑",
      "tags": [
        "running",
        "running toward viewer",
        "motion blur",
        "hair flying"
      ],
      "group": "wk",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "L66",
      "cn": "背向走远",
      "tags": [
        "walking away",
        "back view",
        "looking back",
        "over shoulder"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L67",
      "cn": "大步跨走",
      "tags": [
        "walking",
        "long stride",
        "side view",
        "coat fluttering"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L68",
      "cn": "原地起跳",
      "tags": [
        "jumping",
        "both feet off ground",
        "arms up",
        "hair up"
      ],
      "group": "wk",
      "hint": "足部细节弱：分辨率拉到 1216+，步数 28+",
      "hintAuto": true
    },
    {
      "id": "L69",
      "cn": "蹦跳",
      "tags": [
        "hopping",
        "one foot up",
        "happy",
        "smile"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L70",
      "cn": "轻快小跑",
      "tags": [
        "jogging",
        "light run",
        "smile",
        "outdoors"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L71",
      "cn": "旋转转身",
      "tags": [
        "spinning",
        "twirling",
        "skirt flaring",
        "motion blur"
      ],
      "group": "wk",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "L72",
      "cn": "床上跳跃",
      "tags": [
        "jumping on bed",
        "arms up",
        "laughing",
        "nightwear"
      ],
      "group": "wk",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "L73",
      "cn": "沙滩行走",
      "tags": [
        "walking on beach",
        "barefoot",
        "sand",
        "sunlight"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L74",
      "cn": "雨中奔跑",
      "tags": [
        "running in rain",
        "wet clothes",
        "rain",
        "splashing"
      ],
      "group": "wk",
      "hint": "雨丝乱：负向加 snow；雨滴别开太强",
      "hintAuto": true
    },
    {
      "id": "L75",
      "cn": "踮脚行走",
      "tags": [
        "tiptoe",
        "walking",
        "arms out",
        "balance"
      ],
      "group": "wk",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hintAuto": true
    },
    {
      "id": "L76",
      "cn": "追逐奔跑",
      "tags": [
        "running",
        "looking back",
        "over shoulder",
        "dynamic"
      ],
      "group": "wk",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "L77",
      "cn": "单脚踮转",
      "tags": [
        "spinning on one foot",
        "tiptoe",
        "arms out",
        "dance"
      ],
      "group": "wk",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hintAuto": true
    },
    {
      "id": "L78",
      "cn": "上楼梯",
      "tags": [
        "walking upstairs",
        "side view",
        "hand on railing"
      ],
      "group": "wk",
      "hint": "阶梯线条乱：机位略低，距离 55–75",
      "hintAuto": true
    },
    {
      "id": "L79",
      "cn": "跨步登高",
      "tags": [
        "stepping up",
        "one knee raised",
        "outdoors"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L80",
      "cn": "慢步闲逛",
      "tags": [
        "strolling",
        "hands behind back",
        "looking down",
        "relaxed"
      ],
      "group": "wk",
      "hint": "手在背后看不见：别指望手部细节",
      "hintAuto": true
    },
    {
      "id": "L81",
      "cn": "倒退走",
      "tags": [
        "walking backwards",
        "facing viewer",
        "waving hand"
      ],
      "group": "wk",
      "hint": "动态动作步数 28+，加 motion blur",
      "hintAuto": true
    },
    {
      "id": "L82",
      "cn": "瑜伽树式",
      "tags": [
        "yoga",
        "tree pose",
        "standing on one leg",
        "hands together"
      ],
      "group": "ex",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hintAuto": true
    },
    {
      "id": "L83",
      "cn": "战士式",
      "tags": [
        "yoga",
        "warrior pose",
        "legs apart",
        "arms extended"
      ],
      "group": "ex",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L84",
      "cn": "下犬式",
      "tags": [
        "yoga",
        "downward dog",
        "bent over",
        "hands on floor"
      ],
      "group": "ex",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L85",
      "cn": "莲花坐",
      "tags": [
        "yoga",
        "lotus position",
        "sitting",
        "hands on knees"
      ],
      "group": "ex",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L86",
      "cn": "体前屈",
      "tags": [
        "stretching",
        "touching toes",
        "bent over",
        "legs straight"
      ],
      "group": "ex",
      "hint": "足部细节弱：分辨率拉到 1216+，步数 28+",
      "hard": "足部细节",
      "hintAuto": true
    },
    {
      "id": "L87",
      "cn": "侧弯腰",
      "tags": [
        "side bend",
        "one arm overhead",
        "curved body",
        "stretching"
      ],
      "group": "ex",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L88",
      "cn": "后弯",
      "tags": [
        "backbend",
        "arched back",
        "hands on floor",
        "flexible"
      ],
      "group": "ex",
      "hint": "弓身会拉长躯干：负向加 long torso",
      "hintAuto": true
    },
    {
      "id": "L90",
      "cn": "高踢腿",
      "tags": [
        "high kick",
        "one leg raised",
        "arms out",
        "dynamic"
      ],
      "group": "ex",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hard": "极限柔韧",
      "hintAuto": true
    },
    {
      "id": "L91",
      "cn": "芭蕾站姿",
      "tags": [
        "ballet",
        "first position",
        "arms rounded",
        "upright"
      ],
      "group": "ex",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L92",
      "cn": "平板支撑",
      "tags": [
        "plank",
        "push-up position",
        "elbows",
        "fitness"
      ],
      "group": "ex",
      "hint": "肢体角度极端，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L93",
      "cn": "仰卧起坐",
      "tags": [
        "sit-ups",
        "lying on back",
        "knees bent",
        "fitness"
      ],
      "group": "ex",
      "hint": "仰卧注意透视压缩：机位 45° 俯拍更准",
      "hintAuto": true
    },
    {
      "id": "L94",
      "cn": "俯卧撑",
      "tags": [
        "push-up",
        "arms bent",
        "on floor",
        "fitness"
      ],
      "group": "ex",
      "hint": "肢体角度极端，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L95",
      "cn": "开合跳",
      "tags": [
        "jumping jack",
        "arms up",
        "legs apart",
        "fitness"
      ],
      "group": "ex",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "L96",
      "cn": "拉弓射箭",
      "tags": [
        "archery",
        "drawing bow",
        "aiming",
        "side view"
      ],
      "group": "ex",
      "hint": "肢体角度极端，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L97",
      "cn": "拉伸小腿",
      "tags": [
        "stretching calf",
        "leg extended",
        "leaning forward"
      ],
      "group": "ex",
      "hint": "瑜伽垫/背景会抢戏：白色背景更稳",
      "hintAuto": true
    },
    {
      "id": "L98",
      "cn": "芭蕾阿拉贝斯克",
      "tags": [
        "ballet",
        "arabesque",
        "one leg raised behind",
        "arms extended"
      ],
      "group": "dn",
      "hint": "单腿平衡易倒：加 (standing:1.1) 稳住构图",
      "hard": "极限柔韧",
      "hintAuto": true
    },
    {
      "id": "L99",
      "cn": "旋转舞姿",
      "tags": [
        "pirouette",
        "spinning",
        "arms up",
        "skirt flaring"
      ],
      "group": "dn",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L100",
      "cn": "现代舞姿",
      "tags": [
        "contemporary dance",
        "flowing pose",
        "barefoot",
        "arms curved"
      ],
      "group": "dn",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L101",
      "cn": "街舞站姿",
      "tags": [
        "hip hop pose",
        "wide stance",
        "arms crossed",
        "attitude"
      ],
      "group": "dn",
      "hint": "抱胸手臂会融合：负向加 fused arms",
      "hintAuto": true
    },
    {
      "id": "L102",
      "cn": "爵士手势",
      "tags": [
        "jazz hands",
        "arms out",
        "showgirl",
        "smile"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L103",
      "cn": "萨尔萨舞步",
      "tags": [
        "salsa pose",
        "hips out",
        "one arm up",
        "partner pose"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L104",
      "cn": "探戈下腰",
      "tags": [
        "tango",
        "dip pose",
        "leaning back",
        "dramatic"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L105",
      "cn": "华尔兹姿势",
      "tags": [
        "waltz hold",
        "arms raised",
        "elegant",
        "ballroom"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L106",
      "cn": "啦啦队姿势",
      "tags": [
        "cheerleader pose",
        "pompoms",
        "leg raised",
        "smile"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L107",
      "cn": "偶像姿势",
      "tags": [
        "idol pose",
        "hand near face",
        "wink",
        "stage"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L108",
      "cn": "比耶手势",
      "tags": [
        "peace sign",
        "looking at viewer",
        "smile",
        "hand up"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L109",
      "cn": "比心",
      "tags": [
        "finger heart",
        "hand gesture",
        "smile",
        "looking at viewer"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L110",
      "cn": "飞吻",
      "tags": [
        "blowing kiss",
        "hand near mouth",
        "wink",
        "playful"
      ],
      "group": "dn",
      "hint": "接吻两人脸融合：负向加 fused faces，步数 30+",
      "hard": "双人面部贴合",
      "hintAuto": true
    },
    {
      "id": "L111",
      "cn": "挥手打招呼",
      "tags": [
        "waving hand",
        "smile",
        "facing viewer",
        "friendly"
      ],
      "group": "dn",
      "hint": "舞台类建议加 spotlight / stage",
      "hintAuto": true
    },
    {
      "id": "L112",
      "cn": "鞠躬致意",
      "tags": [
        "bowing",
        "hands at sides",
        "polite",
        "standing"
      ],
      "group": "dn",
      "hint": "鞠躬会挡脸：机位略低更自然",
      "hintAuto": true
    },
    {
      "id": "L113",
      "cn": "持扇舞",
      "tags": [
        "fan dance",
        "holding fan",
        "flowing pose",
        "kimono"
      ],
      "group": "dn",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "L114",
      "cn": "持剑站立",
      "tags": [
        "holding sword",
        "standing",
        "serious",
        "weapon"
      ],
      "group": "ac",
      "hint": "道具形状易崩：负向加 extra weapons，别用特写",
      "hard": "道具精细结构",
      "hintAuto": true
    },
    {
      "id": "L115",
      "cn": "持枪瞄准",
      "tags": [
        "holding gun",
        "aiming",
        "serious",
        "two hands"
      ],
      "group": "ac",
      "hint": "道具形状易崩：负向加 extra weapons，别用特写",
      "hard": "道具精细结构",
      "hintAuto": true
    },
    {
      "id": "L116",
      "cn": "持法杖",
      "tags": [
        "holding staff",
        "standing",
        "magic",
        "fantasy"
      ],
      "group": "ac",
      "hint": "道具形状易崩：负向加 extra weapons，别用特写",
      "hintAuto": true
    },
    {
      "id": "L117",
      "cn": "持团扇",
      "tags": [
        "holding folding fan",
        "elegant",
        "kimono",
        "standing"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L118",
      "cn": "捧花束",
      "tags": [
        "holding bouquet",
        "looking at flowers",
        "smile",
        "standing"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L119",
      "cn": "捧杯",
      "tags": [
        "holding cup",
        "both hands",
        "looking at viewer",
        "warm"
      ],
      "group": "ac",
      "hint": "手持小物件易变形：距离 40–55",
      "hintAuto": true
    },
    {
      "id": "L120",
      "cn": "看书",
      "tags": [
        "reading book",
        "holding book",
        "looking down",
        "sitting"
      ],
      "group": "ac",
      "hint": "手持小物件易变形：距离 40–55",
      "hintAuto": true
    },
    {
      "id": "L121",
      "cn": "写字",
      "tags": [
        "writing",
        "holding pen",
        "leaning over desk",
        "focused"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L122",
      "cn": "拉小提琴",
      "tags": [
        "playing violin",
        "holding violin",
        "bow",
        "eyes closed"
      ],
      "group": "ac",
      "hint": "乐器细节要求高：步数 32+，机位偏侧面",
      "hard": "道具精细结构",
      "hintAuto": true
    },
    {
      "id": "L123",
      "cn": "弹吉他",
      "tags": [
        "playing guitar",
        "holding guitar",
        "sitting",
        "smile"
      ],
      "group": "ac",
      "hint": "乐器细节要求高：步数 32+，机位偏侧面",
      "hard": "道具精细结构",
      "hintAuto": true
    },
    {
      "id": "L124",
      "cn": "看手机",
      "tags": [
        "holding phone",
        "looking at phone",
        "standing",
        "casual"
      ],
      "group": "ac",
      "hint": "自拍手机易变形：镜头距离 40–55，手部负向加 extra fingers",
      "hard": "手部+屏幕",
      "hintAuto": true
    },
    {
      "id": "L125",
      "cn": "扶眼镜",
      "tags": [
        "adjusting glasses",
        "one hand",
        "looking at viewer",
        "serious"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L126",
      "cn": "扎头发",
      "tags": [
        "tying hair",
        "hands in hair",
        "looking away",
        "ponytail"
      ],
      "group": "ac",
      "hint": "手指插进头发易糊：机位偏侧面",
      "hintAuto": true
    },
    {
      "id": "L127",
      "cn": "穿外套",
      "tags": [
        "putting on jacket",
        "one arm in sleeve",
        "standing"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L128",
      "cn": "脱鞋",
      "tags": [
        "taking off shoes",
        "bending over",
        "one knee up"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L129",
      "cn": "喝水",
      "tags": [
        "drinking",
        "holding bottle",
        "head tilted back",
        "throat"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L130",
      "cn": "吃东西",
      "tags": [
        "eating",
        "holding food",
        "mouth open",
        "smile"
      ],
      "group": "ac",
      "hint": "手里有道具：负向加 extra objects",
      "hintAuto": true
    },
    {
      "id": "L131",
      "cn": "撑伞回望",
      "tags": [
        "holding umbrella",
        "looking back",
        "rain",
        "over shoulder"
      ],
      "group": "ac",
      "hint": "伞骨易乱：负向加 extra umbrella",
      "hintAuto": true
    },
    {
      "id": "L132",
      "cn": "背影站立",
      "tags": [
        "back view",
        "standing",
        "arms at sides",
        "long hair"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L133",
      "cn": "背影行走",
      "tags": [
        "back view",
        "walking away",
        "mid-stride",
        "hair swaying"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L134",
      "cn": "背影而坐",
      "tags": [
        "back view",
        "sitting",
        "looking away",
        "window"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L135",
      "cn": "剪影",
      "tags": [
        "silhouette",
        "backlighting",
        "standing",
        "dramatic"
      ],
      "group": "bk",
      "hint": "剪影看不出细节：关掉面部细化 LoRA",
      "hintAuto": true
    },
    {
      "id": "L136",
      "cn": "侧身站姿",
      "tags": [
        "side view",
        "standing",
        "profile",
        "looking forward"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L137",
      "cn": "四分之三背面",
      "tags": [
        "three-quarter view",
        "from behind",
        "looking over shoulder"
      ],
      "group": "bk",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "L138",
      "cn": "坐着回头",
      "tags": [
        "sitting",
        "looking back",
        "over shoulder",
        "on chair"
      ],
      "group": "bk",
      "hint": "椅子结构易崩：负向加 extra legs",
      "hintAuto": true
    },
    {
      "id": "L139",
      "cn": "双手背后站立",
      "tags": [
        "standing",
        "hands behind back",
        "back view",
        "head down"
      ],
      "group": "bk",
      "hint": "手在背后看不见：别指望手部细节",
      "hintAuto": true
    },
    {
      "id": "L140",
      "cn": "门口而立",
      "tags": [
        "standing in doorway",
        "backlit",
        "facing away",
        "silhouette"
      ],
      "group": "bk",
      "hint": "剪影看不出细节：关掉面部细化 LoRA",
      "hintAuto": true
    },
    {
      "id": "L141",
      "cn": "立于窗前",
      "tags": [
        "standing at window",
        "back view",
        "curtains",
        "light"
      ],
      "group": "bk",
      "hint": "窗户逆光会吃细节：加 rim light",
      "hintAuto": true
    },
    {
      "id": "L142",
      "cn": "阳台倚栏",
      "tags": [
        "on balcony",
        "leaning on railing",
        "back view",
        "city"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L143",
      "cn": "拖行李走远",
      "tags": [
        "walking away",
        "pulling suitcase",
        "back view",
        "airport"
      ],
      "group": "bk",
      "hint": "背影看不到脸：表情/妆容词基本无效",
      "hintAuto": true
    },
    {
      "id": "L144",
      "cn": "眼睛特写",
      "tags": [
        "close-up",
        "eyes",
        "detailed eyes",
        "looking at viewer"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L145",
      "cn": "嘴唇特写",
      "tags": [
        "close-up",
        "lips",
        "glossy lips",
        "parted lips"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L146",
      "cn": "手部特写",
      "tags": [
        "close-up",
        "hand focus",
        "fingers",
        "delicate"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L147",
      "cn": "足部特写",
      "tags": [
        "close-up",
        "feet",
        "barefoot",
        "toes"
      ],
      "group": "cl",
      "hint": "足部细节弱：分辨率拉到 1216+，步数 28+",
      "hard": "足部细节",
      "hintAuto": true
    },
    {
      "id": "L148",
      "cn": "头发特写",
      "tags": [
        "close-up",
        "hair focus",
        "flowing hair",
        "strands"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L149",
      "cn": "背部特写",
      "tags": [
        "close-up",
        "back focus",
        "shoulder blades",
        "bare back"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L150",
      "cn": "锁骨特写",
      "tags": [
        "close-up",
        "collarbone",
        "neck",
        "skin"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L151",
      "cn": "微笑特写",
      "tags": [
        "close-up",
        "smile",
        "looking at viewer",
        "soft light"
      ],
      "group": "cl",
      "hint": "特写用 1:1 或 3:4，距离 0–25，别开全身负向",
      "hintAuto": true
    },
    {
      "id": "L152",
      "cn": "侧脸剪影",
      "tags": [
        "close-up",
        "profile",
        "silhouette",
        "rim light"
      ],
      "group": "cl",
      "hint": "剪影看不出细节：关掉面部细化 LoRA",
      "hintAuto": true
    },
    {
      "id": "L153",
      "cn": "镜中自拍",
      "tags": [
        "mirror selfie",
        "holding phone",
        "looking at mirror",
        "close-up"
      ],
      "group": "cl",
      "hint": "镜面会多画人：负向加 reflection, duplicate",
      "hard": "镜面反射",
      "hintAuto": true
    },
    {
      "id": "LT01",
      "cn": "正面拥抱",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "facing each other",
        "standing",
        "embrace"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT02",
      "cn": "背后抱",
      "tags": [
        "1boy",
        "1girl",
        "hug from behind",
        "arms around waist",
        "looking at viewer"
      ],
      "group": "cp",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "LT03",
      "cn": "紧抱",
      "tags": [
        "1boy",
        "1girl",
        "tight hug",
        "arms around neck",
        "eyes closed"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT04",
      "cn": "侧身抱",
      "tags": [
        "1boy",
        "1girl",
        "side hug",
        "one arm around shoulder",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT05",
      "cn": "抱起拥抱",
      "tags": [
        "1boy",
        "1girl",
        "lifting hug",
        "holding her up",
        "feet off ground"
      ],
      "group": "cp",
      "hint": "足部细节弱：分辨率拉到 1216+，步数 28+",
      "hintAuto": true
    },
    {
      "id": "LT06",
      "cn": "贴脸抱",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "cheek to cheek",
        "nuzzling"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT07",
      "cn": "相拥而坐",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "sitting together",
        "legs tangled"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT08",
      "cn": "枕腿相拥",
      "tags": [
        "1boy",
        "1girl",
        "head on lap",
        "sitting",
        "gentle smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT09",
      "cn": "并肩牵手",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "walking together",
        "side by side"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT10",
      "cn": "十指相扣",
      "tags": [
        "1boy",
        "1girl",
        "interlocked fingers",
        "holding hands",
        "close-up"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hard": "手指交扣",
      "hintAuto": true
    },
    {
      "id": "LT11",
      "cn": "牵手前行",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "leading",
        "walking",
        "from behind"
      ],
      "group": "cp",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "LT12",
      "cn": "拉手回头",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "looking back",
        "smile"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT13",
      "cn": "单指牵手",
      "tags": [
        "1boy",
        "1girl",
        "holding pinkies",
        "pinky promise",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT14",
      "cn": "牵手奔跑",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "running",
        "laughing",
        "motion blur"
      ],
      "group": "cp",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "LT15",
      "cn": "牵手相视",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "looking at each other",
        "soft smile"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT16",
      "cn": "手背轻吻",
      "tags": [
        "1boy",
        "1girl",
        "kissing hand",
        "holding hands",
        "elegant"
      ],
      "group": "cp",
      "hint": "接吻两人脸融合：负向加 fused faces，步数 30+",
      "hard": "双人面部贴合",
      "hintAuto": true
    },
    {
      "id": "LT17",
      "cn": "额头相抵",
      "tags": [
        "1boy",
        "1girl",
        "forehead-to-forehead",
        "eyes closed",
        "close-up"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT18",
      "cn": "吻额头",
      "tags": [
        "1boy",
        "1girl",
        "forehead kiss",
        "eyes closed",
        "tender"
      ],
      "group": "cp",
      "hint": "接吻两人脸融合：负向加 fused faces，步数 30+",
      "hard": "双人面部贴合",
      "hintAuto": true
    },
    {
      "id": "LT19",
      "cn": "吻脸颊",
      "tags": [
        "1boy",
        "1girl",
        "cheek kiss",
        "blush",
        "smile"
      ],
      "group": "cp",
      "hint": "接吻两人脸融合：负向加 fused faces，步数 30+",
      "hard": "双人面部贴合",
      "hintAuto": true
    },
    {
      "id": "LT20",
      "cn": "鼻尖相碰",
      "tags": [
        "1boy",
        "1girl",
        "nose to nose",
        "close-up",
        "flirtatious"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT21",
      "cn": "靠肩而坐",
      "tags": [
        "1boy",
        "1girl",
        "head on shoulder",
        "sitting",
        "eyes closed"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT22",
      "cn": "依偎",
      "tags": [
        "1boy",
        "1girl",
        "leaning on each other",
        "cuddling",
        "sitting"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT23",
      "cn": "耳语",
      "tags": [
        "1boy",
        "1girl",
        "leaning toward",
        "whispering",
        "close-up"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT24",
      "cn": "摸头",
      "tags": [
        "1boy",
        "1girl",
        "head pat",
        "looking up",
        "smile"
      ],
      "group": "cp",
      "hint": "手放在头上会穿模：机位偏侧",
      "hintAuto": true
    },
    {
      "id": "LT25",
      "cn": "公主抱",
      "tags": [
        "1boy",
        "1girl",
        "princess carry",
        "holding in arms",
        "looking at viewer"
      ],
      "group": "cp",
      "hint": "抱人时两人比例容易错：横构图，距离 55–70",
      "hintAuto": true
    },
    {
      "id": "LT26",
      "cn": "背人",
      "tags": [
        "1boy",
        "1girl",
        "piggyback",
        "arms around neck",
        "smile"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT27",
      "cn": "肩上骑",
      "tags": [
        "1boy",
        "1girl",
        "on shoulders",
        "holding her legs",
        "cheerful"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT28",
      "cn": "横抱",
      "tags": [
        "1boy",
        "1girl",
        "carrying",
        "bridal style",
        "dramatic"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT29",
      "cn": "双臂环抱",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "lifting her",
        "feet off ground"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT30",
      "cn": "抱着转圈",
      "tags": [
        "1boy",
        "1girl",
        "lifting",
        "spinning",
        "motion blur",
        "laughing"
      ],
      "group": "cp",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "LT31",
      "cn": "抱膝而坐",
      "tags": [
        "1boy",
        "1girl",
        "sitting on his lap",
        "hugging knees",
        "leaning back"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT32",
      "cn": "席地相依",
      "tags": [
        "1boy",
        "1girl",
        "sitting on floor",
        "back to back",
        "looking away"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT33",
      "cn": "背靠背站",
      "tags": [
        "1boy",
        "1girl",
        "back to back",
        "standing",
        "arms crossed"
      ],
      "group": "cp",
      "hint": "抱胸手臂会融合：负向加 fused arms",
      "hintAuto": true
    },
    {
      "id": "LT34",
      "cn": "背靠背坐",
      "tags": [
        "1boy",
        "1girl",
        "back to back",
        "sitting on floor",
        "eyes closed"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT35",
      "cn": "并坐",
      "tags": [
        "1boy",
        "1girl",
        "sitting side by side",
        "hands on knees",
        "looking forward"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT36",
      "cn": "头对头躺",
      "tags": [
        "1boy",
        "1girl",
        "lying on floor",
        "head to head",
        "looking up"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT37",
      "cn": "共撑一伞",
      "tags": [
        "1boy",
        "1girl",
        "sharing umbrella",
        "rain",
        "walking together"
      ],
      "group": "cp",
      "hint": "伞骨易乱：负向加 extra umbrella",
      "hintAuto": true
    },
    {
      "id": "LT38",
      "cn": "共舞",
      "tags": [
        "1boy",
        "1girl",
        "dancing",
        "waltz hold",
        "elegant",
        "ballroom"
      ],
      "group": "cp",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "LT39",
      "cn": "扶腰舞姿",
      "tags": [
        "1boy",
        "1girl",
        "dancing",
        "hand on waist",
        "close together"
      ],
      "group": "cp",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "LT40",
      "cn": "下腰舞",
      "tags": [
        "1boy",
        "1girl",
        "dip pose",
        "tango",
        "dramatic",
        "leaning back"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT41",
      "cn": "喂食",
      "tags": [
        "1boy",
        "1girl",
        "feeding",
        "holding chopsticks",
        "sitting",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT42",
      "cn": "共食",
      "tags": [
        "1boy",
        "1girl",
        "sharing food",
        "eating",
        "sitting together"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT43",
      "cn": "擦脸",
      "tags": [
        "1boy",
        "1girl",
        "wiping face",
        "holding handkerchief",
        "gentle"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT44",
      "cn": "打领带",
      "tags": [
        "1boy",
        "1girl",
        "tying necktie",
        "both standing",
        "focused"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT45",
      "cn": "为对方梳发",
      "tags": [
        "1boy",
        "1girl",
        "brushing hair",
        "sitting",
        "behind her"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT46",
      "cn": "合影自拍",
      "tags": [
        "1boy",
        "1girl",
        "selfie",
        "holding phone",
        "smile",
        "close together"
      ],
      "group": "cp",
      "hint": "自拍手机易变形：镜头距离 40–55，手部负向加 extra fingers",
      "hard": "手部+屏幕",
      "hintAuto": true
    },
    {
      "id": "LT47",
      "cn": "击掌",
      "tags": [
        "1boy",
        "1girl",
        "high five",
        "smile",
        "dynamic"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT48",
      "cn": "碰拳",
      "tags": [
        "1boy",
        "1girl",
        "fist bump",
        "smile",
        "close-up hands"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT49",
      "cn": "握手",
      "tags": [
        "1boy",
        "1girl",
        "handshake",
        "standing",
        "formal"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT50",
      "cn": "相向鞠躬",
      "tags": [
        "1boy",
        "1girl",
        "bowing to each other",
        "standing",
        "polite"
      ],
      "group": "cp",
      "hint": "鞠躬会挡脸：机位略低更自然",
      "hintAuto": true
    },
    {
      "id": "LT51",
      "cn": "捏脸颊",
      "tags": [
        "1boy",
        "1girl",
        "cheek pinch",
        "pouting",
        "playful"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT52",
      "cn": "挽手臂",
      "tags": [
        "1boy",
        "1girl",
        "arm in arm",
        "walking",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT53",
      "cn": "挽手并立",
      "tags": [
        "1boy",
        "1girl",
        "linking arms",
        "standing",
        "facing viewer"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT54",
      "cn": "背对背睡",
      "tags": [
        "1boy",
        "1girl",
        "sleeping",
        "back to back",
        "lying on bed"
      ],
      "group": "cp",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "LT55",
      "cn": "膝枕",
      "tags": [
        "1boy",
        "1girl",
        "head on lap",
        "sitting",
        "stroking hair"
      ],
      "group": "cp",
      "hint": "手放在头上会穿模：机位偏侧",
      "hintAuto": true
    },
    {
      "id": "LT56",
      "cn": "耳畔轻语",
      "tags": [
        "1boy",
        "1girl",
        "whispering",
        "hand on shoulder",
        "close-up"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT57",
      "cn": "扶肩对视",
      "tags": [
        "1boy",
        "1girl",
        "hands on shoulders",
        "looking at each other"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT58",
      "cn": "牵手相拥",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "holding hands",
        "standing"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT59",
      "cn": "倚靠背后",
      "tags": [
        "1boy",
        "1girl",
        "leaning against his back",
        "standing",
        "arms around"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT60",
      "cn": "抬下巴对视",
      "tags": [
        "1boy",
        "1girl",
        "chin lift",
        "looking at each other",
        "close-up"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT61",
      "cn": "牵手坐台阶",
      "tags": [
        "1boy",
        "1girl",
        "sitting on stairs",
        "holding hands",
        "looking away"
      ],
      "group": "cp",
      "hint": "阶梯线条乱：机位略低，距离 55–75",
      "hintAuto": true
    },
    {
      "id": "LT62",
      "cn": "并肩远望",
      "tags": [
        "1boy",
        "1girl",
        "standing side by side",
        "looking away",
        "outdoors"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT63",
      "cn": "同撑栏杆",
      "tags": [
        "1boy",
        "1girl",
        "leaning on railing",
        "side by side",
        "city lights"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT64",
      "cn": "舞台谢幕",
      "tags": [
        "1boy",
        "1girl",
        "bowing together",
        "stage",
        "holding hands"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT65",
      "cn": "牵手转身",
      "tags": [
        "1boy",
        "1girl",
        "holding hands",
        "spinning",
        "looking at each other"
      ],
      "group": "cp",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "LT66",
      "cn": "臂弯并肩",
      "tags": [
        "1boy",
        "1girl",
        "arm in arm",
        "walking",
        "side by side"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT67",
      "cn": "抱腰对视",
      "tags": [
        "1boy",
        "1girl",
        "hands on waist",
        "looking at each other",
        "close"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT68",
      "cn": "坐地相靠",
      "tags": [
        "1boy",
        "1girl",
        "sitting on floor",
        "leaning together",
        "eyes closed"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT69",
      "cn": "肩并肩躺",
      "tags": [
        "1boy",
        "1girl",
        "lying side by side",
        "looking up",
        "on bed"
      ],
      "group": "cp",
      "hint": "床单褶皱会抢细节：负向加 messy sheets",
      "hintAuto": true
    },
    {
      "id": "LT70",
      "cn": "举高转圈",
      "tags": [
        "1boy",
        "1girl",
        "lifting her up",
        "spinning",
        "laughing"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT71",
      "cn": "背人奔跑",
      "tags": [
        "1boy",
        "1girl",
        "piggyback",
        "running",
        "smile",
        "motion blur"
      ],
      "group": "cp",
      "hint": "抱持类手部易崩：加 wide shot，别用特写裁切",
      "hard": "抱持负重",
      "hintAuto": true
    },
    {
      "id": "LT72",
      "cn": "面对面坐膝",
      "tags": [
        "1boy",
        "1girl",
        "sitting on his lap",
        "facing each other",
        "holding hands"
      ],
      "group": "cp",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LT73",
      "cn": "摸头对视",
      "tags": [
        "1boy",
        "1girl",
        "head pat",
        "looking at each other",
        "gentle smile"
      ],
      "group": "cp",
      "hint": "手放在头上会穿模：机位偏侧",
      "hintAuto": true
    },
    {
      "id": "LT74",
      "cn": "抱膝对坐",
      "tags": [
        "1boy",
        "1girl",
        "sitting facing each other",
        "hugging knees",
        "on floor"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT75",
      "cn": "递花",
      "tags": [
        "1boy",
        "1girl",
        "handing flower",
        "standing",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT76",
      "cn": "披外套",
      "tags": [
        "1boy",
        "1girl",
        "putting jacket on her shoulders",
        "standing",
        "from behind"
      ],
      "group": "cp",
      "hint": "后入类：机位略低拍臀线，负向加 fused bodies",
      "hintAuto": true
    },
    {
      "id": "LT77",
      "cn": "系鞋带",
      "tags": [
        "1boy",
        "1girl",
        "kneeling",
        "tying shoelaces",
        "looking down"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT78",
      "cn": "撑伞奔跑",
      "tags": [
        "1boy",
        "1girl",
        "holding umbrella",
        "running together",
        "rain"
      ],
      "group": "cp",
      "hint": "伞骨易乱：负向加 extra umbrella",
      "hintAuto": true
    },
    {
      "id": "LT79",
      "cn": "双人比心",
      "tags": [
        "1boy",
        "1girl",
        "finger heart",
        "standing together",
        "smile"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT80",
      "cn": "双人自拍",
      "tags": [
        "1boy",
        "1girl",
        "selfie",
        "holding phone",
        "cheek to cheek"
      ],
      "group": "cp",
      "hint": "自拍手机易变形：镜头距离 40–55，手部负向加 extra fingers",
      "hard": "手部+屏幕",
      "hintAuto": true
    },
    {
      "id": "LT81",
      "cn": "相拥背对镜头",
      "tags": [
        "1boy",
        "1girl",
        "hugging",
        "back view",
        "facing away"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT82",
      "cn": "倚肩小睡",
      "tags": [
        "1boy",
        "1girl",
        "head on shoulder",
        "sleeping",
        "sitting"
      ],
      "group": "cp",
      "hint": "双人横构图 16:9，距离 45–65，别用特写",
      "hintAuto": true
    },
    {
      "id": "LT83",
      "cn": "牵手坐台阶",
      "tags": [
        "1boy",
        "1girl",
        "sitting on stairs",
        "holding hands",
        "side by side"
      ],
      "group": "cp",
      "hint": "阶梯线条乱：机位略低，距离 55–75",
      "hintAuto": true
    },
    {
      "id": "LT84",
      "cn": "同看一本书",
      "tags": [
        "1boy",
        "1girl",
        "reading together",
        "holding book",
        "heads close"
      ],
      "group": "cp",
      "hint": "手持小物件易变形：距离 40–55",
      "hintAuto": true
    },
    {
      "id": "LP01",
      "cn": "三人合影",
      "tags": [
        "3girls",
        "group photo",
        "standing together",
        "smile"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP02",
      "cn": "中间挽手",
      "tags": [
        "3girls",
        "arm in arm",
        "walking together",
        "smile"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP03",
      "cn": "闺蜜群像",
      "tags": [
        "3girls",
        "posing",
        "fashion",
        "looking at viewer"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP04",
      "cn": "三人并坐",
      "tags": [
        "3girls",
        "sitting side by side",
        "hands on knees"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP05",
      "cn": "群体跳跃",
      "tags": [
        "3girls",
        "jumping",
        "arms up",
        "laughing"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "LP06",
      "cn": "人群中的她",
      "tags": [
        "1girl",
        "crowd",
        "many people",
        "looking at viewer"
      ],
      "group": "mp",
      "crowd": "crowd",
      "hint": "人群只画剪影感：负向加 detailed background faces",
      "hintAuto": true
    },
    {
      "id": "LP07",
      "cn": "三人背靠背",
      "tags": [
        "3girls",
        "back to back",
        "standing",
        "arms crossed"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "抱胸手臂会融合：负向加 fused arms",
      "hintAuto": true
    },
    {
      "id": "LP08",
      "cn": "朋友围坐",
      "tags": [
        "3girls",
        "sitting in circle",
        "on floor",
        "talking"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP09",
      "cn": "双胞胎姐妹",
      "tags": [
        "2girls",
        "twins",
        "same face",
        "standing together"
      ],
      "group": "mp",
      "crowd": "2girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP10",
      "cn": "三人共伞",
      "tags": [
        "3girls",
        "sharing umbrella",
        "rain",
        "walking"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "伞骨易乱：负向加 extra umbrella",
      "hintAuto": true
    },
    {
      "id": "LP11",
      "cn": "团队合影",
      "tags": [
        "2girls, 1boy",
        "group photo",
        "standing in row",
        "smile"
      ],
      "group": "mp",
      "crowd": "2girls, 1boy",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP12",
      "cn": "全员鞠躬",
      "tags": [
        "3girls",
        "bowing",
        "standing",
        "stage"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "鞠躬会挡脸：机位略低更自然",
      "hintAuto": true
    },
    {
      "id": "LP13",
      "cn": "三人牵手",
      "tags": [
        "3girls",
        "holding hands",
        "walking",
        "side by side"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "牵手手指最易崩：加 negative extra fingers",
      "hintAuto": true
    },
    {
      "id": "LP14",
      "cn": "姐妹相拥",
      "tags": [
        "2girls",
        "hugging",
        "cheek to cheek",
        "smile"
      ],
      "group": "mp",
      "crowd": "2girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP15",
      "cn": "群体比心",
      "tags": [
        "3girls",
        "finger heart",
        "posing",
        "smile"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP16",
      "cn": "三人自拍",
      "tags": [
        "3girls",
        "selfie",
        "holding phone",
        "close together"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "自拍手机易变形：镜头距离 40–55，手部负向加 extra fingers",
      "hard": "手部+屏幕",
      "hintAuto": true
    },
    {
      "id": "LP17",
      "cn": "闺蜜耳语",
      "tags": [
        "2girls",
        "whispering",
        "close to each other",
        "giggling"
      ],
      "group": "mp",
      "crowd": "2girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP18",
      "cn": "三人共舞",
      "tags": [
        "3girls",
        "dancing",
        "arms linked",
        "motion"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "舞蹈姿态关节多：步数 30+，负向加 broken joints",
      "hintAuto": true
    },
    {
      "id": "LP19",
      "cn": "群体奔跑",
      "tags": [
        "3girls",
        "running",
        "laughing",
        "motion blur"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "动态类要 motion blur，别锁死姿势",
      "hintAuto": true
    },
    {
      "id": "LP20",
      "cn": "围观",
      "tags": [
        "1girl",
        "crowd",
        "watching",
        "background people"
      ],
      "group": "mp",
      "crowd": "crowd",
      "hint": "人群只画剪影感：负向加 detailed background faces",
      "hintAuto": true
    },
    {
      "id": "LP21",
      "cn": "三人躺草地",
      "tags": [
        "3girls",
        "lying on grass",
        "looking up",
        "summer"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP22",
      "cn": "三人阶梯坐",
      "tags": [
        "2girls, 1boy",
        "sitting on stairs",
        "side by side"
      ],
      "group": "mp",
      "crowd": "2girls, 1boy",
      "hint": "阶梯线条乱：机位略低，距离 55–75",
      "hintAuto": true
    },
    {
      "id": "LP23",
      "cn": "兄妹同行",
      "tags": [
        "1girl, 1boy",
        "walking together",
        "side by side",
        "daylight"
      ],
      "group": "mp",
      "crowd": "1girl, 1boy",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    },
    {
      "id": "LP24",
      "cn": "三人对视",
      "tags": [
        "3girls",
        "looking at each other",
        "standing in circle"
      ],
      "group": "mp",
      "crowd": "3girls",
      "hint": "三人以上：简化背景，分辨率 1.5x",
      "hintAuto": true
    }
  ],
  "groups": [
    {
      "id": "sg",
      "name": "站姿",
      "note": ""
    },
    {
      "id": "si",
      "name": "坐卧",
      "note": ""
    },
    {
      "id": "cp",
      "name": "双人",
      "note": "两人同框：拥抱 / 牵手 / 抱持 / 共舞"
    },
    {
      "id": "wk",
      "name": "走跳动态",
      "note": "走路 / 跑 / 跳 / 转身"
    },
    {
      "id": "ex",
      "name": "伸展运动",
      "note": "瑜伽 / 拉伸 / 体态"
    },
    {
      "id": "dn",
      "name": "舞蹈表演",
      "note": "舞蹈 / 偶像 / 手势"
    },
    {
      "id": "ac",
      "name": "持物演绎",
      "note": "持武器 / 道具 / 日常动作"
    },
    {
      "id": "bk",
      "name": "背影侧身",
      "note": "背面 / 侧脸 / 剪影"
    },
    {
      "id": "cl",
      "name": "特写",
      "note": "上半身 / 局部"
    },
    {
      "id": "mp",
      "name": "多人",
      "note": "三人以上同框 / 人群"
    }
  ],
  "kind": "sfw"
};
window.CPS_DATA['data/poses-mid.json'] = {"version":1,"poses":[],"groups":[],"commonSliders":[]};
window.CPS_DATA['data/poses-service.json'] = {"version":1,"poses":[],"groups":[],"commonSliders":[]};
window.CPS_DATA['data/scenes.json'] = {
  "version": 1,
  "module": "scene",
  "title": "场景设定",
  "fields": [
    {
      "id": "location",
      "label": "地点",
      "type": "select",
      "default": "bedroom",
      "priority": 1,
      "hint": "室内场景配「私密」氛围最稳；户外场景模型容易把背景画糊。",
      "options": [
        {
          "v": "bedroom",
          "cn": "卧室"
        },
        {
          "v": "hotel room",
          "cn": "酒店房"
        },
        {
          "v": "love hotel",
          "cn": "情侣酒店"
        },
        {
          "v": "bathroom",
          "cn": "浴室"
        },
        {
          "v": "shower",
          "cn": "淋浴间"
        },
        {
          "v": "bathtub",
          "cn": "浴缸"
        },
        {
          "v": "living room",
          "cn": "客厅"
        },
        {
          "v": "kitchen",
          "cn": "厨房"
        },
        {
          "v": "on table",
          "cn": "餐桌"
        },
        {
          "v": "classroom",
          "cn": "教室"
        },
        {
          "v": "library",
          "cn": "图书馆"
        },
        {
          "v": "office",
          "cn": "办公室"
        },
        {
          "v": "meeting room",
          "cn": "会议室"
        },
        {
          "v": "changing room",
          "cn": "更衣室"
        },
        {
          "v": "fitting room",
          "cn": "试衣间"
        },
        {
          "v": "train interior",
          "cn": "电车"
        },
        {
          "v": "car interior",
          "cn": "车后座"
        },
        {
          "v": "shrine",
          "cn": "神社"
        },
        {
          "v": "bamboo forest",
          "cn": "竹林"
        },
        {
          "v": "japanese garden",
          "cn": "日式庭院"
        },
        {
          "v": "garden",
          "cn": "花园"
        },
        {
          "v": "rooftop",
          "cn": "天台"
        },
        {
          "v": "rainy street",
          "cn": "雨夜街道"
        },
        {
          "v": "neon alley",
          "cn": "霓虹巷"
        },
        {
          "v": "beach",
          "cn": "海边"
        },
        {
          "v": "swimming pool",
          "cn": "泳池"
        },
        {
          "v": "forest",
          "cn": "森林"
        },
        {
          "v": "ruins",
          "cn": "废墟"
        },
        {
          "v": "church",
          "cn": "教堂"
        },
        {
          "v": "tent",
          "cn": "帐篷"
        },
        {
          "v": "attic",
          "cn": "阁楼"
        },
        {
          "v": "dungeon",
          "cn": "地牢"
        },
        {
          "v": "storage room",
          "cn": "储物间"
        },
        {
          "v": "capsule hotel",
          "cn": "胶囊旅馆"
        },
        {
          "v": "dormitory",
          "cn": "宿舍"
        },
        {
          "v": "school hallway",
          "cn": "学校走廊"
        },
        {
          "v": "school gym",
          "cn": "体育馆"
        },
        {
          "v": "school rooftop",
          "cn": "天台"
        },
        {
          "v": "library aisle",
          "cn": "书架间"
        },
        {
          "v": "cubicle",
          "cn": "工位"
        },
        {
          "v": "hospital room",
          "cn": "病房"
        },
        {
          "v": "operating room",
          "cn": "手术室"
        },
        {
          "v": "clinic",
          "cn": "诊所"
        },
        {
          "v": "laboratory",
          "cn": "实验室"
        },
        {
          "v": "prison cell",
          "cn": "牢房"
        },
        {
          "v": "interrogation room",
          "cn": "审讯室"
        },
        {
          "v": "locker room",
          "cn": "更衣室"
        },
        {
          "v": "shower room",
          "cn": "淋浴间"
        },
        {
          "v": "public bath",
          "cn": "公共澡堂"
        },
        {
          "v": "onsen",
          "cn": "温泉"
        },
        {
          "v": "sauna",
          "cn": "桑拿"
        },
        {
          "v": "poolside",
          "cn": "泳池边"
        },
        {
          "v": "gym",
          "cn": "健身房"
        },
        {
          "v": "elevator",
          "cn": "电梯"
        },
        {
          "v": "stairwell",
          "cn": "楼梯间"
        },
        {
          "v": "toilet stall",
          "cn": "厕所隔间"
        },
        {
          "v": "parking lot",
          "cn": "停车场"
        },
        {
          "v": "karaoke box",
          "cn": "KTV 包厢"
        },
        {
          "v": "bar",
          "cn": "酒吧"
        },
        {
          "v": "cafe",
          "cn": "咖啡馆"
        },
        {
          "v": "restaurant",
          "cn": "餐厅"
        },
        {
          "v": "banquet hall",
          "cn": "宴会厅"
        },
        {
          "v": "backstage",
          "cn": "后台"
        },
        {
          "v": "stage",
          "cn": "舞台"
        },
        {
          "v": "photo studio",
          "cn": "摄影棚"
        },
        {
          "v": "airplane bathroom",
          "cn": "飞机洗手间"
        },
        {
          "v": "wedding venue",
          "cn": "婚礼现场"
        },
        {
          "v": "confession booth",
          "cn": "忏悔室"
        },
        {
          "v": "temple",
          "cn": "寺庙"
        },
        {
          "v": "cemetery",
          "cn": "墓地"
        },
        {
          "v": "factory",
          "cn": "工厂"
        },
        {
          "v": "construction site",
          "cn": "工地"
        },
        {
          "v": "abandoned building",
          "cn": "废墟"
        },
        {
          "v": "cave",
          "cn": "洞窟"
        },
        {
          "v": "ocean",
          "cn": "海边"
        },
        {
          "v": "snow field",
          "cn": "雪地"
        },
        {
          "v": "rural area",
          "cn": "乡下"
        },
        {
          "v": "farm",
          "cn": "农场"
        },
        {
          "v": "field",
          "cn": "田野"
        },
        {
          "v": "greenhouse",
          "cn": "温室"
        },
        {
          "v": "alley",
          "cn": "小巷"
        },
        {
          "v": "street",
          "cn": "街道"
        },
        {
          "v": "market",
          "cn": "市场"
        },
        {
          "v": "supermarket",
          "cn": "超市"
        },
        {
          "v": "shopping mall",
          "cn": "商场"
        },
        {
          "v": "clothing store",
          "cn": "服装店"
        },
        {
          "v": "convenience store",
          "cn": "便利店"
        },
        {
          "v": "police station",
          "cn": "警局"
        },
        {
          "v": "security room",
          "cn": "保安室"
        },
        {
          "v": "ferris wheel",
          "cn": "摩天轮"
        },
        {
          "v": "haunted house",
          "cn": "鬼屋"
        },
        {
          "v": "escape room",
          "cn": "密室逃脱"
        },
        {
          "v": "pachinko parlor",
          "cn": "柏青哥"
        },
        {
          "v": "convention hall",
          "cn": "漫展会场"
        },
        {
          "v": "concert venue",
          "cn": "演唱会"
        },
        {
          "v": "festival",
          "cn": "祭典"
        },
        {
          "v": "camping site",
          "cn": "露营地"
        },
        {
          "v": "magic tower",
          "cn": "魔法塔"
        },
        {
          "v": "spaceship interior",
          "cn": "飞船内部"
        },
        {
          "v": "cyberpunk city",
          "cn": "赛博都市"
        },
        {
          "v": "fantasy city",
          "cn": "奇幻都市"
        },
        {
          "v": "elf forest",
          "cn": "精灵森林"
        },
        {
          "v": "dragon lair",
          "cn": "龙巢"
        }
      ],
      "group": "base"
    },
    {
      "id": "time",
      "label": "时间",
      "type": "select",
      "default": "night",
      "priority": 2,
      "hint": "夜晚配霓虹/烛光出氛围最强。",
      "options": [
        {
          "v": "dawn",
          "cn": "清晨"
        },
        {
          "v": "noon",
          "cn": "正午"
        },
        {
          "v": "afternoon",
          "cn": "午后"
        },
        {
          "v": "sunset",
          "cn": "黄昏"
        },
        {
          "v": "blue hour",
          "cn": "蓝调时刻"
        },
        {
          "v": "night",
          "cn": "夜晚"
        },
        {
          "v": "late night",
          "cn": "深夜"
        }
      ],
      "group": "base"
    },
    {
      "id": "lightIntensity",
      "label": "光强",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 3,
      "hint": "81+ 出过曝，皮肤细节会被吃掉。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "dim lighting",
            "dark"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": [
            "low light"
          ]
        },
        {
          "from": 46,
          "to": 75,
          "tags": [
            "well lit"
          ]
        },
        {
          "from": 76,
          "to": 100,
          "tags": [
            "bright",
            "(light:1.2)",
            "overexposed"
          ]
        }
      ],
      "optional": true,
      "group": "light"
    },
    {
      "id": "colorTemp",
      "label": "色温",
      "type": "slider",
      "min": -100,
      "max": 100,
      "default": 0,
      "priority": 3,
      "hint": "负值冷蓝、正值暖橙。深色皮肤配暖光会发红。",
      "map": [
        {
          "from": -100,
          "to": -50,
          "tags": [
            "cold light",
            "blue tint"
          ]
        },
        {
          "from": -49,
          "to": -10,
          "tags": [
            "cool light"
          ]
        },
        {
          "from": -9,
          "to": 9,
          "tags": []
        },
        {
          "from": 10,
          "to": 49,
          "tags": [
            "warm light"
          ]
        },
        {
          "from": 50,
          "to": 100,
          "tags": [
            "warm light",
            "orange tint",
            "golden"
          ]
        }
      ],
      "optional": true,
      "group": "light"
    },
    {
      "id": "volumetrics",
      "label": "体积光/尘埃",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 20,
      "priority": 3,
      "hint": "60+ 出 god rays，写实模型效果好、动漫模型容易脏。",
      "map": [
        {
          "from": 0,
          "to": 30,
          "tags": []
        },
        {
          "from": 31,
          "to": 65,
          "tags": [
            "volumetric lighting",
            "god rays"
          ]
        },
        {
          "from": 66,
          "to": 100,
          "tags": [
            "volumetric lighting",
            "god rays",
            "dust motes",
            "lens flare"
          ]
        }
      ],
      "optional": true,
      "group": "light"
    },
    {
      "id": "bokeh",
      "label": "背景虚化",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 4,
      "hint": "70+ 出明显 bokeh；太高会让场景信息全丢。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "sharp background"
          ]
        },
        {
          "from": 26,
          "to": 60,
          "tags": [
            "depth of field"
          ]
        },
        {
          "from": 61,
          "to": 100,
          "tags": [
            "depth of field",
            "bokeh",
            "(blurry background:1.2)"
          ]
        }
      ],
      "optional": true,
      "group": "light"
    },
    {
      "id": "focal",
      "label": "焦距",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 5,
      "hint": "0 广角透视夸张，100 长焦压缩背景。人像用 60–80 最好看。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "wide angle",
            "fisheye"
          ]
        },
        {
          "from": 21,
          "to": 45,
          "tags": [
            "35mm"
          ]
        },
        {
          "from": 46,
          "to": 70,
          "tags": [
            "50mm"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "telephoto",
            "85mm",
            "compressed background"
          ]
        }
      ],
      "optional": true,
      "group": "light"
    },
    {
      "id": "view",
      "label": "视角",
      "type": "multi",
      "default": [],
      "priority": 2,
      "hint": "与动作模块的镜头滑条会叠加，冲突时以动作模块为准。",
      "options": [
        {
          "v": "straight-on",
          "cn": "正面"
        },
        {
          "v": "from the side",
          "cn": "侧面"
        },
        {
          "v": "from behind",
          "cn": "背面"
        },
        {
          "v": "from above",
          "cn": "俯视"
        },
        {
          "v": "from below",
          "cn": "仰视"
        },
        {
          "v": "dutch angle",
          "cn": "斜角"
        },
        {
          "v": "over the shoulder",
          "cn": "过肩"
        },
        {
          "v": "pov",
          "cn": "第一人称"
        }
      ],
      "uiIn": "pose",
      "group": "comp"
    },
    {
      "id": "composition",
      "label": "构图",
      "type": "select",
      "default": "centered",
      "priority": 3,
      "hint": "对称构图适合正面站姿，三分法适合环境人像。",
      "options": [
        {
          "v": "centered",
          "cn": "居中"
        },
        {
          "v": "rule of thirds",
          "cn": "三分法"
        },
        {
          "v": "symmetrical",
          "cn": "对称"
        },
        {
          "v": "off-center",
          "cn": "偏置"
        }
      ],
      "optional": true,
      "group": "comp"
    },
    {
      "id": "quality",
      "label": "画质",
      "type": "multi",
      "default": [
        "8k",
        "ultra-detailed"
      ],
      "priority": 2,
      "hint": "Pony 系不吃 8k/absurdres 这类词，切到写实模型时自动过滤。",
      "options": [
        {
          "v": "8k",
          "cn": "8K"
        },
        {
          "v": "absurdres",
          "cn": "超高清"
        },
        {
          "v": "highres",
          "cn": "高清"
        },
        {
          "v": "ultra-detailed",
          "cn": "超精细"
        },
        {
          "v": "intricate details",
          "cn": "复杂细节"
        },
        {
          "v": "detailed background",
          "cn": "细节背景"
        }
      ],
      "group": "mood"
    },
    {
      "id": "atmosphere",
      "label": "氛围特效",
      "type": "multi",
      "default": [],
      "priority": 2,
      "hint": "粒子特效会抢画面注意力，人物特写时慎用。",
      "options": [
        {
          "v": "petals",
          "cn": "花瓣"
        },
        {
          "v": "cherry blossoms",
          "cn": "樱花飞舞"
        },
        {
          "v": "rain drops",
          "cn": "雨滴"
        },
        {
          "v": "splashing water",
          "cn": "水花"
        },
        {
          "v": "smoke",
          "cn": "烟雾"
        },
        {
          "v": "light particles",
          "cn": "光斑"
        },
        {
          "v": "confetti",
          "cn": "彩纸"
        },
        {
          "v": "falling leaves",
          "cn": "落叶"
        },
        {
          "v": "snowflakes",
          "cn": "雪花"
        },
        {
          "v": "steam",
          "cn": "雾气"
        }
      ],
      "group": "mood"
    },
    {
      "id": "weather",
      "label": "天气",
      "type": "select",
      "default": "clear",
      "priority": 3,
      "hint": "雨天会自动挂 wet 类词，与服装湿透度叠加。",
      "options": [
        {
          "v": "clear",
          "cn": "晴"
        },
        {
          "v": "cloudy",
          "cn": "阴"
        },
        {
          "v": "light rain",
          "cn": "小雨"
        },
        {
          "v": "heavy rain",
          "cn": "暴雨"
        },
        {
          "v": "snow",
          "cn": "雪"
        },
        {
          "v": "fog",
          "cn": "雾"
        },
        {
          "v": "thunderstorm",
          "cn": "雷雨"
        }
      ],
      "optional": true,
      "group": "extra"
    },
    {
      "id": "light",
      "label": "光源",
      "type": "multi",
      "default": [
        "window light"
      ],
      "priority": 2,
      "hint": "叠超过 3 个光源模型会混乱，建议 1–2 个。",
      "options": [
        {
          "v": "natural light",
          "cn": "自然光"
        },
        {
          "v": "golden hour",
          "cn": "黄金时刻"
        },
        {
          "v": "window light",
          "cn": "窗光"
        },
        {
          "v": "candlelight",
          "cn": "烛光"
        },
        {
          "v": "neon light",
          "cn": "霓虹"
        },
        {
          "v": "neon signs",
          "cn": "霓虹招牌"
        },
        {
          "v": "moonlight",
          "cn": "月光"
        },
        {
          "v": "backlighting",
          "cn": "逆光"
        },
        {
          "v": "rim light",
          "cn": "侧逆光"
        },
        {
          "v": "softbox",
          "cn": "柔光箱"
        },
        {
          "v": "flash",
          "cn": "闪光灯"
        },
        {
          "v": "fluorescent",
          "cn": "荧光灯"
        },
        {
          "v": "fireplace",
          "cn": "壁炉光"
        }
      ],
      "group": "extra"
    },
    {
      "id": "props",
      "label": "场景陈设",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "base",
      "default": [],
      "hint": "具体家具和物件。上面的「地点」给大方向，这里补画面上真实出现的陈设。",
      "options": [
        {
          "v": "bed",
          "cn": "床"
        },
        {
          "v": "bed sheet",
          "cn": "床单"
        },
        {
          "v": "pillow",
          "cn": "枕头"
        },
        {
          "v": "blanket",
          "cn": "被子"
        },
        {
          "v": "bed frame",
          "cn": "床架"
        },
        {
          "v": "headboard",
          "cn": "床头板"
        },
        {
          "v": "mattress",
          "cn": "床垫"
        },
        {
          "v": "sofa",
          "cn": "沙发"
        },
        {
          "v": "couch",
          "cn": "长沙发"
        },
        {
          "v": "armchair",
          "cn": "单人沙发"
        },
        {
          "v": "cushion",
          "cn": "靠垫"
        },
        {
          "v": "chair",
          "cn": "椅子"
        },
        {
          "v": "wooden chair",
          "cn": "木椅"
        },
        {
          "v": "stool",
          "cn": "凳子"
        },
        {
          "v": "bar stool",
          "cn": "吧台凳"
        },
        {
          "v": "desk",
          "cn": "书桌"
        },
        {
          "v": "table",
          "cn": "桌子"
        },
        {
          "v": "dining table",
          "cn": "餐桌"
        },
        {
          "v": "coffee table",
          "cn": "茶几"
        },
        {
          "v": "counter",
          "cn": "柜台"
        },
        {
          "v": "kitchen counter",
          "cn": "厨房台面"
        },
        {
          "v": "bathtub",
          "cn": "浴缸"
        },
        {
          "v": "shower",
          "cn": "淋浴"
        },
        {
          "v": "sink",
          "cn": "洗手台"
        },
        {
          "v": "toilet",
          "cn": "马桶"
        },
        {
          "v": "mirror",
          "cn": "镜子"
        },
        {
          "v": "wall mirror",
          "cn": "墙面镜"
        },
        {
          "v": "full-length mirror",
          "cn": "全身镜"
        },
        {
          "v": "window",
          "cn": "窗"
        },
        {
          "v": "curtain",
          "cn": "窗帘"
        },
        {
          "v": "blinds",
          "cn": "百叶窗"
        },
        {
          "v": "glass door",
          "cn": "玻璃门"
        },
        {
          "v": "door",
          "cn": "门"
        },
        {
          "v": "doorway",
          "cn": "门口"
        },
        {
          "v": "wall",
          "cn": "墙"
        },
        {
          "v": "floor",
          "cn": "地板"
        },
        {
          "v": "carpet",
          "cn": "地毯"
        },
        {
          "v": "tatami",
          "cn": "榻榻米"
        },
        {
          "v": "wooden floor",
          "cn": "木地板"
        },
        {
          "v": "tile floor",
          "cn": "瓷砖地"
        },
        {
          "v": "stairs",
          "cn": "楼梯"
        },
        {
          "v": "elevator",
          "cn": "电梯"
        },
        {
          "v": "balcony",
          "cn": "阳台"
        },
        {
          "v": "rooftop",
          "cn": "天台"
        },
        {
          "v": "wardrobe",
          "cn": "衣柜"
        },
        {
          "v": "dresser",
          "cn": "梳妆台"
        },
        {
          "v": "bookshelf",
          "cn": "书架"
        },
        {
          "v": "car seat",
          "cn": "车座"
        },
        {
          "v": "steering wheel",
          "cn": "方向盘"
        },
        {
          "v": "washing machine",
          "cn": "洗衣机"
        },
        {
          "v": "rope",
          "cn": "绳子"
        },
        {
          "v": "candle",
          "cn": "蜡烛"
        },
        {
          "v": "string lights",
          "cn": "串灯"
        },
        {
          "v": "potted plant",
          "cn": "盆栽"
        },
        {
          "v": "flowers",
          "cn": "花"
        },
        {
          "v": "poster",
          "cn": "海报"
        }
      ]
    }
  ],
  "groups": [
    {
      "id": "base",
      "name": "地点与时间",
      "note": "地点、时间、场景陈设"
    },
    {
      "id": "light",
      "name": "光线",
      "note": "光强、色温、虚化"
    },
    {
      "id": "comp",
      "name": "构图",
      "note": "视角、构图"
    },
    {
      "id": "mood",
      "name": "氛围与画质",
      "note": "画质、氛围特效"
    },
    {
      "id": "extra",
      "name": "天气与光源",
      "note": "天气、补光方向、光位"
    }
  ]
};
window.CPS_DATA['data/features.json'] = {
  "version": 1,
  "module": "feature",
  "title": "特征设定",
  "fields": [
    {
      "id": "skinState",
      "label": "皮肤状态",
      "type": "multi",
      "default": [],
      "priority": 3,
      "hint": "",
      "options": [
        {
          "v": "clear skin",
          "cn": "光洁"
        },
        {
          "v": "glowing skin",
          "cn": "发光肌"
        },
        {
          "v": "moist skin",
          "cn": "水润"
        },
        {
          "v": "dry skin",
          "cn": "干燥"
        },
        {
          "v": "glossy skin",
          "cn": "光泽"
        },
        {
          "v": "textured skin",
          "cn": "肌理感"
        },
        {
          "v": "smooth skin",
          "cn": "光滑"
        },
        {
          "v": "rough skin",
          "cn": "粗糙"
        },
        {
          "v": "veiny skin",
          "cn": "血管明显"
        },
        {
          "v": "flushed skin",
          "cn": "泛红"
        },
        {
          "v": "dewy skin",
          "cn": "水光"
        },
        {
          "v": "matte skin",
          "cn": "哑光"
        }
      ],
      "optional": true,
      "group": "body"
    },
    {
      "id": "pregnant",
      "label": "孕肚月数",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 0,
      "priority": 5,
      "hint": "需同时勾选「孕肚」，否则无效。",
      "map": [
        {
          "from": 0,
          "to": 5,
          "tags": []
        },
        {
          "from": 6,
          "to": 30,
          "tags": [
            "pregnant"
          ]
        },
        {
          "from": 31,
          "to": 70,
          "tags": [
            "pregnant",
            "big belly"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "pregnant",
            "big belly",
            "(pregnant:1.2)"
          ]
        }
      ],
      "optional": true,
      "group": "body"
    },
    {
      "id": "bodyDetail",
      "label": "身体标记",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "body",
      "default": [],
      "hint": "骨架、肌肉、体态细节。人物页有整体参数，这里加局部特征。",
      "options": [
        {
          "v": "collarbone",
          "cn": "锁骨"
        },
        {
          "v": "navel",
          "cn": "肚脐"
        },
        {
          "v": "armpits",
          "cn": "腋下"
        },
        {
          "v": "toned female abs",
          "cn": "腹肌(女)"
        },
        {
          "v": "toned",
          "cn": "紧实"
        },
        {
          "v": "muscular female",
          "cn": "肌肉女"
        },
        {
          "v": "veins on skin",
          "cn": "皮肤血管"
        },
        {
          "v": "visible ribs",
          "cn": "肋骨"
        },
        {
          "v": "hip bones",
          "cn": "胯骨"
        },
        {
          "v": "back dimples",
          "cn": "腰窝"
        },
        {
          "v": "shoulder blades",
          "cn": "肩胛骨"
        },
        {
          "v": "long legs",
          "cn": "长腿"
        },
        {
          "v": "thick thighs",
          "cn": "丰满大腿"
        },
        {
          "v": "thigh gap",
          "cn": "腿缝"
        },
        {
          "v": "narrow waist",
          "cn": "细腰"
        },
        {
          "v": "wide hips",
          "cn": "宽胯"
        },
        {
          "v": "plump",
          "cn": "丰腴"
        },
        {
          "v": "soft body",
          "cn": "软肉感"
        },
        {
          "v": "chubby",
          "cn": "微胖"
        },
        {
          "v": "skinny",
          "cn": "骨感"
        },
        {
          "v": "petite",
          "cn": "娇小"
        },
        {
          "v": "tall female",
          "cn": "高个"
        },
        {
          "v": "large breasts",
          "cn": "大胸"
        },
        {
          "v": "huge breasts",
          "cn": "巨乳"
        },
        {
          "v": "small breasts",
          "cn": "小胸"
        },
        {
          "v": "sagging breasts",
          "cn": "下垂"
        },
        {
          "v": "fingernails",
          "cn": "指甲"
        },
        {
          "v": "long toenails",
          "cn": "长脚趾甲"
        },
        {
          "v": "armpit fetish",
          "cn": "腋下恋物"
        },
        {
          "v": "foot focus",
          "cn": "脚部特写"
        },
        {
          "v": "soles",
          "cn": "脚底"
        },
        {
          "v": "toes",
          "cn": "脚趾"
        },
        {
          "v": "bridges of feet",
          "cn": "足弓"
        },
        {
          "v": "clavicle",
          "cn": "锁骨"
        },
        {
          "v": "small waist",
          "cn": "细腰"
        },
        {
          "v": "flat chest",
          "cn": "平胸"
        },
        {
          "v": "muscular",
          "cn": "肌肉"
        },
        {
          "v": "stomach bulge",
          "cn": "腹部隆起"
        },
        {
          "v": "pregnant",
          "cn": "孕肚"
        },
        {
          "v": "veins",
          "cn": "血管"
        },
        {
          "v": "freckles",
          "cn": "雀斑"
        },
        {
          "v": "mole under eye",
          "cn": "泪痣"
        },
        {
          "v": "fang",
          "cn": "虎牙"
        },
        {
          "v": "ahoge",
          "cn": "呆毛"
        },
        {
          "v": "birthmark",
          "cn": "胎记"
        },
        {
          "v": "beauty mark",
          "cn": "美人痣"
        },
        {
          "v": "dimples",
          "cn": "酒窝"
        },
        {
          "v": "gap teeth",
          "cn": "虎牙缝"
        },
        {
          "v": "cute fang",
          "cn": "小虎牙"
        },
        {
          "v": "mole on thigh",
          "cn": "大腿痣"
        },
        {
          "v": "mole on breast",
          "cn": "胸前痣"
        },
        {
          "v": "scar on face",
          "cn": "面部疤痕"
        },
        {
          "v": "bandaid",
          "cn": "创可贴"
        },
        {
          "v": "bandage",
          "cn": "绷带"
        },
        {
          "v": "eyepatch",
          "cn": "眼罩(医疗)"
        },
        {
          "v": "birthmark on back",
          "cn": "背部胎记"
        }
      ]
    },
    {
      "id": "skinDetail",
      "label": "皮肤与痕迹",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "body",
      "default": [],
      "hint": "汗、油光、红痕、指痕、绳痕。写实模型对这种材质反应更明显。",
      "options": [
        {
          "v": "sweat",
          "cn": "汗"
        },
        {
          "v": "sweatdrop",
          "cn": "汗珠"
        },
        {
          "v": "profuse sweating",
          "cn": "大汗"
        },
        {
          "v": "shiny skin",
          "cn": "油光"
        },
        {
          "v": "wet skin",
          "cn": "湿润"
        },
        {
          "v": "water drops",
          "cn": "水珠"
        },
        {
          "v": "blush",
          "cn": "脸红"
        },
        {
          "v": "full-face blush",
          "cn": "满脸通红"
        },
        {
          "v": "bruises",
          "cn": "淤青"
        },
        {
          "v": "finger marks",
          "cn": "指痕"
        },
        {
          "v": "scratch marks",
          "cn": "抓痕"
        },
        {
          "v": "scars",
          "cn": "疤痕"
        },
        {
          "v": "whip marks",
          "cn": "鞭痕"
        },
        {
          "v": "rope marks",
          "cn": "绳痕"
        },
        {
          "v": "sunburn",
          "cn": "晒伤"
        },
        {
          "v": "stretch marks",
          "cn": "妊娠纹"
        }
      ]
    },
    {
      "id": "tattooDetail",
      "label": "纹身位置",
      "type": "multi",
      "optional": true,
      "priority": 4,
      "hint": "「身体特征」里的「纹身」是泛词，这里指定位置会更准。",
      "options": [
        {
          "v": "tattoo",
          "cn": "纹身"
        },
        {
          "v": "arm tattoo",
          "cn": "手臂"
        },
        {
          "v": "thigh tattoo",
          "cn": "大腿"
        },
        {
          "v": "back tattoo",
          "cn": "后背"
        },
        {
          "v": "chest tattoo",
          "cn": "胸口"
        },
        {
          "v": "stomach tattoo",
          "cn": "腹部"
        },
        {
          "v": "shoulder tattoo",
          "cn": "肩膀"
        },
        {
          "v": "neck tattoo",
          "cn": "脖颈"
        },
        {
          "v": "leg tattoo",
          "cn": "小腿"
        },
        {
          "v": "hand tattoo",
          "cn": "手背"
        },
        {
          "v": "hip tattoo",
          "cn": "胯部"
        },
        {
          "v": "face tattoo",
          "cn": "面部"
        },
        {
          "v": "tramp stamp",
          "cn": "腰后"
        },
        {
          "v": "tribal tattoo",
          "cn": "部落图腾"
        },
        {
          "v": "floral tattoo",
          "cn": "花卉"
        },
        {
          "v": "dragon tattoo",
          "cn": "龙纹"
        },
        {
          "v": "heart tattoo",
          "cn": "心形"
        },
        {
          "v": "butterfly tattoo",
          "cn": "蝴蝶"
        },
        {
          "v": "womb tattoo",
          "cn": "子宫纹"
        },
        {
          "v": "full body tattoo",
          "cn": "全身"
        }
      ],
      "group": "deco"
    },
    {
      "id": "clothDetail",
      "label": "服装细节",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "deco",
      "default": [],
      "hint": "走光、透视、贴身、半脱。跟服装页搭配用，能让画面更「有戏」。",
      "options": [
        {
          "v": "cleavage",
          "cn": "乳沟"
        },
        {
          "v": "see-through",
          "cn": "透视"
        },
        {
          "v": "transparent clothing",
          "cn": "透明衣料"
        },
        {
          "v": "wet clothes",
          "cn": "湿身"
        },
        {
          "v": "tight clothes",
          "cn": "紧身"
        },
        {
          "v": "loose clothes",
          "cn": "宽松"
        },
        {
          "v": "sleeveless",
          "cn": "无袖"
        },
        {
          "v": "off shoulder",
          "cn": "露肩"
        },
        {
          "v": "bare shoulders",
          "cn": "裸肩"
        },
        {
          "v": "midriff",
          "cn": "露腰"
        },
        {
          "v": "crop top",
          "cn": "露脐上衣"
        },
        {
          "v": "short shorts",
          "cn": "超短裤"
        },
        {
          "v": "miniskirt",
          "cn": "迷你裙"
        },
        {
          "v": "long skirt",
          "cn": "长裙"
        },
        {
          "v": "slit skirt",
          "cn": "开叉裙"
        },
        {
          "v": "high slit",
          "cn": "高开叉"
        },
        {
          "v": "open clothes",
          "cn": "敞开"
        },
        {
          "v": "clothes lift",
          "cn": "衣摆掀起"
        },
        {
          "v": "clothes pull",
          "cn": "拉扯衣料"
        },
        {
          "v": "undressing",
          "cn": "正在脱"
        },
        {
          "v": "partially undressed",
          "cn": "半脱"
        },
        {
          "v": "wardrobe malfunction",
          "cn": "走光"
        },
        {
          "v": "panties peek",
          "cn": "内裤露边"
        },
        {
          "v": "strap slip",
          "cn": "肩带滑落"
        },
        {
          "v": "torn clothes",
          "cn": "破损衣物"
        }
      ]
    },
    {
      "id": "gesture",
      "label": "手部细节",
      "type": "multi",
      "default": [],
      "priority": 5,
      "hint": "手部是 SDXL 最容易崩的地方，加这些词会轻微提高崩坏率。",
      "options": [
        {
          "v": "fingernails",
          "cn": "指甲"
        },
        {
          "v": "long nails",
          "cn": "长指甲"
        },
        {
          "v": "painted nails",
          "cn": "涂指甲"
        },
        {
          "v": "french nails",
          "cn": "法式美甲"
        },
        {
          "v": "hand on own chest",
          "cn": "手抚胸"
        },
        {
          "v": "hands on hips",
          "cn": "叉腰"
        },
        {
          "v": "arms behind back",
          "cn": "手背后"
        },
        {
          "v": "arms up",
          "cn": "举手"
        },
        {
          "v": "stretched arms",
          "cn": "伸展手臂"
        },
        {
          "v": "clenched hands",
          "cn": "握拳"
        },
        {
          "v": "interlocked fingers",
          "cn": "十指相扣"
        },
        {
          "v": "v sign",
          "cn": "剪刀手"
        },
        {
          "v": "hand on own face",
          "cn": "手扶脸"
        },
        {
          "v": "covering mouth",
          "cn": "遮嘴"
        },
        {
          "v": "hand between legs",
          "cn": "手夹腿间"
        },
        {
          "v": "fingers in mouth",
          "cn": "手指含口"
        },
        {
          "v": "peace sign",
          "cn": "比耶"
        }
      ],
      "optional": true,
      "group": "hand"
    },
    {
      "id": "expression",
      "label": "表情",
      "type": "multi",
      "default": [],
      "priority": 2,
      "hint": "",
      "options": [
        {
          "v": "smile",
          "cn": "微笑"
        },
        {
          "v": "laughing",
          "cn": "大笑"
        },
        {
          "v": "shy",
          "cn": "害羞"
        },
        {
          "v": "biting lips",
          "cn": "咬唇"
        },
        {
          "v": "open mouth",
          "cn": "张嘴"
        },
        {
          "v": "tongue out",
          "cn": "吐舌"
        },
        {
          "v": "squinting",
          "cn": "眯眼"
        },
        {
          "v": "closed eyes",
          "cn": "闭眼"
        },
        {
          "v": "rolling eyes",
          "cn": "翻白眼"
        },
        {
          "v": "tears",
          "cn": "眼泪"
        },
        {
          "v": "frown",
          "cn": "皱眉"
        },
        {
          "v": "surprised",
          "cn": "惊讶"
        },
        {
          "v": "disgusted",
          "cn": "嫌弃"
        },
        {
          "v": "smirk",
          "cn": "淫笑"
        },
        {
          "v": "licking lips",
          "cn": "舔唇"
        },
        {
          "v": "half-closed eyes",
          "cn": "半睁眼"
        },
        {
          "v": "empty eyes",
          "cn": "空洞眼神"
        },
        {
          "v": "rolled eyes",
          "cn": "翻白眼"
        },
        {
          "v": "heart-shaped pupils",
          "cn": "爱心瞳"
        },
        {
          "v": "streaming tears",
          "cn": "泪流满面"
        },
        {
          "v": "crying",
          "cn": "哭泣"
        },
        {
          "v": "tongue visible",
          "cn": "露舌"
        },
        {
          "v": "wink",
          "cn": "眨眼"
        },
        {
          "v": "smug",
          "cn": "得意"
        },
        {
          "v": "disgust",
          "cn": "嫌恶"
        },
        {
          "v": "angry",
          "cn": "生气"
        },
        {
          "v": "embarrassed",
          "cn": "难为情"
        },
        {
          "v": "seductive smile",
          "cn": "媚笑"
        },
        {
          "v": "evil smile",
          "cn": "坏笑"
        },
        {
          "v": "grin",
          "cn": "咧嘴笑"
        },
        {
          "v": "parted lips",
          "cn": "微张唇"
        },
        {
          "v": "biting lip",
          "cn": "咬唇"
        },
        {
          "v": "pout",
          "cn": "嘟嘴"
        },
        {
          "v": "nose blush",
          "cn": "鼻尖泛红"
        },
        {
          "v": "snot",
          "cn": "鼻涕"
        },
        {
          "v": "unconscious",
          "cn": "昏迷"
        }
      ],
      "optional": true,
      "group": "comp",
      "uiIn": "pose"
    },
    {
      "id": "gaze",
      "label": "视线",
      "type": "select",
      "default": "looking at viewer",
      "priority": 3,
      "hint": "看镜头＝互动感；看别处＝旁观感，适合偷拍风。",
      "options": [
        {
          "v": "looking at viewer",
          "cn": "看镜头"
        },
        {
          "v": "looking away",
          "cn": "看别处"
        },
        {
          "v": "looking down",
          "cn": "看下方"
        },
        {
          "v": "looking up",
          "cn": "向上看"
        },
        {
          "v": "looking back",
          "cn": "回头看"
        },
        {
          "v": "looking to the side",
          "cn": "看侧面"
        },
        {
          "v": "eye contact",
          "cn": "对视"
        },
        {
          "v": "glancing",
          "cn": "斜视"
        },
        {
          "v": "staring",
          "cn": "凝视"
        },
        {
          "v": "closed eyes",
          "cn": "闭眼"
        },
        {
          "v": "looking over shoulder",
          "cn": "回头望"
        },
        {
          "v": "half-closed eyes",
          "cn": "半闭眼"
        }
      ],
      "optional": true,
      "group": "comp",
      "uiIn": "pose"
    },
    {
      "id": "interact",
      "label": "人物互动",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "deco",
      "default": [],
      "hint": "两个人在做什么：拥抱、接吻、牵手、摸头等。可多选 1–2 个。",
      "options": [
        {
          "v": "hug",
          "cn": "拥抱"
        },
        {
          "v": "tight hug",
          "cn": "紧抱"
        },
        {
          "v": "back hug",
          "cn": "背后抱"
        },
        {
          "v": "kiss",
          "cn": "接吻"
        },
        {
          "v": "french kiss",
          "cn": "法式接吻"
        },
        {
          "v": "deep kiss",
          "cn": "深吻"
        },
        {
          "v": "hand holding",
          "cn": "牵手"
        },
        {
          "v": "interlocked fingers",
          "cn": "十指相扣"
        },
        {
          "v": "headpat",
          "cn": "摸头"
        },
        {
          "v": "lap pillow",
          "cn": "枕膝"
        },
        {
          "v": "carrying",
          "cn": "抱着"
        },
        {
          "v": "bridal carry",
          "cn": "公主抱"
        },
        {
          "v": "cuddling",
          "cn": "依偎"
        },
        {
          "v": "ear whisper",
          "cn": "耳语"
        },
        {
          "v": "arm around waist",
          "cn": "搂腰"
        },
        {
          "v": "arm around shoulder",
          "cn": "搂肩"
        },
        {
          "v": "holding hands behind back",
          "cn": "背后牵手"
        },
        {
          "v": "cheek to cheek",
          "cn": "贴脸"
        },
        {
          "v": "licking lips",
          "cn": "舔唇"
        },
        {
          "v": "biting ear",
          "cn": "咬耳"
        }
      ],
      "uiIn": "pose"
    },
    {
      "id": "state",
      "label": "特殊状态",
      "type": "multi",
      "priority": 2,
      "optional": true,
      "group": "body",
      "default": [],
      "hint": "",
      "options": [
        {
          "v": "drunk",
          "cn": "醉酒"
        },
        {
          "v": "drunk blush",
          "cn": "醉红"
        },
        {
          "v": "sleeping",
          "cn": "睡着"
        },
        {
          "v": "sleepy",
          "cn": "困倦"
        },
        {
          "v": "just woke up",
          "cn": "刚睡醒"
        },
        {
          "v": "unconscious",
          "cn": "昏迷"
        },
        {
          "v": "hypnosis",
          "cn": "被催眠"
        },
        {
          "v": "mind control",
          "cn": "被控制"
        },
        {
          "v": "weak",
          "cn": "虚弱"
        },
        {
          "v": "exhausted",
          "cn": "精疲力尽"
        },
        {
          "v": "panting",
          "cn": "喘息"
        },
        {
          "v": "breathless",
          "cn": "喘不过气"
        },
        {
          "v": "fever",
          "cn": "发烧"
        },
        {
          "v": "heat",
          "cn": "发情"
        },
        {
          "v": "trembling",
          "cn": "颤抖"
        },
        {
          "v": "shivering",
          "cn": "发抖"
        },
        {
          "v": "limp",
          "cn": "瘫软"
        },
        {
          "v": "aroused",
          "cn": "动情"
        },
        {
          "v": "horny",
          "cn": "欲求不满"
        },
        {
          "v": "after sex",
          "cn": "事后"
        },
        {
          "v": "orgasm",
          "cn": "高潮"
        },
        {
          "v": "overstimulation",
          "cn": "过度刺激"
        }
      ]
    },
    {
      "id": "crowd",
      "label": "画面人数",
      "type": "select",
      "priority": 1,
      "optional": true,
      "group": "crowd",
      "default": null,
      "hint": "默认是 1 女 1 男。选多人时注意：模型对 3 人以上容易画崩，建议配合简化姿势。",
      "options": [
        {
          "v": "1girl",
          "cn": "只有女方",
          "tags": [
            "1girl",
            "solo"
          ]
        },
        {
          "v": "1girl, 1boy",
          "cn": "1 女 1 男（默认）",
          "tags": [
            "1girl",
            "1boy"
          ]
        },
        {
          "v": "2girls, 1boy",
          "cn": "2 女 1 男",
          "tags": [
            "2girls",
            "1boy"
          ]
        },
        {
          "v": "1girl, 2boys",
          "cn": "1 女 2 男",
          "tags": [
            "1girl",
            "2boys"
          ]
        },
        {
          "v": "2girls, 2boys",
          "cn": "2 女 2 男",
          "tags": [
            "2girls",
            "2boys"
          ]
        },
        {
          "v": "3girls, 1boy",
          "cn": "3 女 1 男",
          "tags": [
            "3girls",
            "1boy"
          ]
        },
        {
          "v": "3girls",
          "cn": "3 女",
          "tags": [
            "3girls",
            "multiple girls"
          ]
        },
        {
          "v": "multiple girls, multiple boys",
          "cn": "群像",
          "tags": [
            "multiple girls",
            "multiple boys"
          ]
        },
        {
          "v": "crowd",
          "cn": "人群背景",
          "tags": [
            "crowd",
            "many people"
          ]
        }
      ]
    }
  ],
  "groups": [
    {
      "id": "crowd",
      "name": "画面人数",
      "note": "单人、双人、多人"
    },
    {
      "id": "body",
      "name": "身体状态",
      "note": "皮肤、孕肚、身体特征"
    },
    {
      "id": "deco",
      "name": "装饰与道具",
      "note": "饰品、玩具、纹身"
    },
    {
      "id": "hand",
      "name": "手部动作",
      "note": "手指、指甲、手势"
    }
  ]
};
window.CPS_DATA['data/styles.json'] = {
  "version": 1,
  "module": "style",
  "title": "画风设定",
  "fields": [
    {
      "id": "category",
      "label": "画面风格",
      "type": "select",
      "default": "none",
      "priority": 3,
      "hint": "选具体风格会覆盖写实度的一部分词。none = 完全交给写实度滑条。",
      "options": [
        {
          "v": "none",
          "cn": "不指定"
        },
        {
          "v": "realistic photo",
          "cn": "真实摄影"
        },
        {
          "v": "film",
          "cn": "胶片"
        },
        {
          "v": "snapshot",
          "cn": "手机随手拍"
        },
        {
          "v": "product",
          "cn": "商品摄影"
        },
        {
          "v": "cinematic",
          "cn": "电影感"
        },
        {
          "v": "editorial",
          "cn": "时尚杂志"
        },
        {
          "v": "gravure",
          "cn": "私影写真"
        },
        {
          "v": "anime cel",
          "cn": "日系赛璐璐"
        },
        {
          "v": "painterly",
          "cn": "厚涂"
        },
        {
          "v": "watercolor",
          "cn": "水彩"
        },
        {
          "v": "flat color",
          "cn": "平涂"
        },
        {
          "v": "galgame cg",
          "cn": "Galgame 立绘"
        },
        {
          "v": "light novel",
          "cn": "轻小说插绘"
        },
        {
          "v": "manga",
          "cn": "漫画黑白"
        },
        {
          "v": "2.5d",
          "cn": "2.5D 半写实"
        },
        {
          "v": "cyberpunk",
          "cn": "赛博朋克"
        },
        {
          "v": "vaporwave",
          "cn": "蒸汽波"
        },
        {
          "v": "oil painting",
          "cn": "油画"
        },
        {
          "v": "sketch",
          "cn": "素描"
        },
        {
          "v": "3d render",
          "cn": "3D 渲染"
        },
        {
          "v": "clay",
          "cn": "黏土"
        },
        {
          "v": "pixel art",
          "cn": "像素"
        }
      ],
      "optional": true
    },
    {
      "id": "artists",
      "label": "画图风格",
      "type": "multi",
      "default": [],
      "priority": 3,
      "hint": "仅 Illustrious 系有效，Pony 下自动失效。1–2 位最佳，叠多了会互相污染。",
      "options": [
        {
          "v": "asanagi",
          "cn": "浓艳厚涂·熟女肉感"
        },
        {
          "v": "michiking",
          "cn": "饱满肉感·明亮漫画"
        },
        {
          "v": "shindol",
          "cn": "写实厚涂·强明暗"
        },
        {
          "v": "hisasi",
          "cn": "柔和清透·软光"
        },
        {
          "v": "saitom",
          "cn": "清爽通透·细线条"
        },
        {
          "v": "z-ton",
          "cn": "丰满体态·浓墨线"
        },
        {
          "v": "mogudan",
          "cn": "丰腴柔软·圆润脸"
        },
        {
          "v": "hamao",
          "cn": "细腻肤色·柔光写实"
        },
        {
          "v": "kikurage",
          "cn": "冷调薄涂·细眼"
        },
        {
          "v": "nardack",
          "cn": "明快厚涂·高完成度"
        },
        {
          "v": "lpip",
          "cn": "轻薄淡彩·空气感"
        },
        {
          "v": "ke-ta",
          "cn": "柔焦梦幻·低饱和"
        },
        {
          "v": "bokuman",
          "cn": "浓密笔触·暖色皮肤"
        },
        {
          "v": "tamano kedama",
          "cn": "柔软蓬松·奶白高光"
        },
        {
          "v": "mika pikazo",
          "cn": "高饱和潮色·霓虹撞色"
        },
        {
          "v": "kishida mel",
          "cn": "清透柔和·插画感"
        },
        {
          "v": "yabuki kentarou",
          "cn": "明快少年漫·利落线"
        },
        {
          "v": "guweiz",
          "cn": "厚涂写实·电影光"
        },
        {
          "v": "sakimichan",
          "cn": "欧美厚涂·油亮皮肤"
        },
        {
          "v": "wlop",
          "cn": "强光影厚涂·氛围感"
        },
        {
          "v": "artgerm",
          "cn": "精致定妆·唯美写实"
        },
        {
          "v": "rella",
          "cn": "精细线稿·繁复细节"
        },
        {
          "v": "askzy",
          "cn": "韩式写实·柔和骨相"
        },
        {
          "v": "ciloranko",
          "cn": "韩式厚涂·柔光皮肤"
        },
        {
          "v": "dingyonghhh",
          "cn": "国风写意·水墨晕染"
        }
      ],
      "optional": true,
      "hideTag": true
    },
    {
      "id": "realism",
      "label": "写实度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 20,
      "priority": 1,
      "hint": "这是 MIXED 滑条：同时改词和 cfg。0=纯动漫、100=照片。与所选模型冲突时会提示。",
      "param": {
        "cfg": [
          5.5,
          4.5
        ]
      },
      "map": [
        {
          "from": 0,
          "to": 15,
          "tags": [
            "anime style",
            "cel shading",
            "flat color",
            "lineart",
            "(anime:1.2)"
          ]
        },
        {
          "from": 16,
          "to": 35,
          "tags": [
            "anime coloring",
            "semi-realistic"
          ]
        },
        {
          "from": 36,
          "to": 55,
          "tags": [
            "illustration",
            "painterly",
            "soft shading",
            "concept art"
          ]
        },
        {
          "from": 56,
          "to": 80,
          "tags": [
            "realistic",
            "photo-realistic",
            "skin texture",
            "(photorealistic:1.1)"
          ]
        },
        {
          "from": 81,
          "to": 100,
          "tags": [
            "raw photo",
            "photograph",
            "film grain",
            "(photorealistic:1.3)",
            "35mm"
          ]
        }
      ]
    },
    {
      "id": "lineWeight",
      "label": "线条强度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 30,
      "priority": 4,
      "hint": "写实度 >60 时线条基本会被吃掉。",
      "map": [
        {
          "from": 0,
          "to": 20,
          "tags": [
            "no lineart"
          ]
        },
        {
          "from": 21,
          "to": 60,
          "tags": [
            "lineart"
          ]
        },
        {
          "from": 61,
          "to": 100,
          "tags": [
            "thick outlines",
            "bold lineart"
          ]
        }
      ],
      "optional": true
    },
    {
      "id": "contrast",
      "label": "明暗对比",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 3,
      "hint": "80+ 出 chiaroscuro，暗部细节会丢。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "flat lighting"
          ]
        },
        {
          "from": 26,
          "to": 65,
          "tags": [
            "soft lighting"
          ]
        },
        {
          "from": 66,
          "to": 100,
          "tags": [
            "dramatic lighting",
            "high contrast",
            "chiaroscuro"
          ]
        }
      ],
      "optional": true
    },
    {
      "id": "saturation",
      "label": "饱和度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 50,
      "priority": 4,
      "hint": "0 出单色/去色，100 出高饱和。",
      "map": [
        {
          "from": 0,
          "to": 15,
          "tags": [
            "monochrome",
            "greyscale"
          ]
        },
        {
          "from": 16,
          "to": 35,
          "tags": [
            "desaturated",
            "muted colors"
          ]
        },
        {
          "from": 36,
          "to": 70,
          "tags": []
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "vivid colors",
            "saturated",
            "(vivid colors:1.15)"
          ]
        }
      ],
      "optional": true
    },
    {
      "id": "renderDetail",
      "label": "渲染精细度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 60,
      "priority": 3,
      "hint": "PARAM 滑条：直接改采样步数（20→40）。步数越高越慢，100 时单张耗时明显增加，按自己的显卡酌情调。",
      "param": {
        "steps": [
          20,
          40
        ]
      },
      "map": [
        {
          "from": 0,
          "to": 30,
          "tags": []
        },
        {
          "from": 31,
          "to": 70,
          "tags": [
            "detailed"
          ]
        },
        {
          "from": 71,
          "to": 100,
          "tags": [
            "ultra-detailed",
            "intricate details",
            "(detailed:1.15)"
          ]
        }
      ],
      "optional": true
    },
    {
      "id": "grain",
      "label": "肌理噪点",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 20,
      "priority": 5,
      "hint": "写实模型 40–60 有胶片感；动漫模型加噪点会显脏。",
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "clean",
            "smooth"
          ]
        },
        {
          "from": 26,
          "to": 65,
          "tags": [
            "film grain"
          ]
        },
        {
          "from": 66,
          "to": 100,
          "tags": [
            "grainy",
            "film grain",
            "noise",
            "textured"
          ]
        }
      ],
      "optional": true
    },
    {
      "id": "stylization",
      "label": "风格夸张度",
      "type": "slider",
      "min": 0,
      "max": 100,
      "default": 40,
      "priority": 5,
      "hint": "PARAM 滑条：反向改 cfg（7→4.5）。值越高越自由也越容易崩。",
      "param": {
        "cfgInverse": [
          7,
          4.5
        ]
      },
      "map": [
        {
          "from": 0,
          "to": 25,
          "tags": [
            "accurate anatomy"
          ]
        },
        {
          "from": 26,
          "to": 65,
          "tags": [
            "stylized"
          ]
        },
        {
          "from": 66,
          "to": 100,
          "tags": [
            "stylized",
            "(exaggerated:1.2)",
            "dynamic composition"
          ]
        }
      ],
      "optional": true
    }
  ]
};
window.CPS_DATA['data/lora.json'] = {"version":1,"module":"lora","items":[],"rules":[]};
window.CPS_DATA['data/negatives.json'] = {
  "version": 1,
  "module": "negative",
  "title": "负面提示词",
  "groups": [
    {
      "id": "base",
      "name": "基础质量（必带）",
      "tags": [
        "worst quality",
        "low quality",
        "lowres",
        "jpeg artifacts",
        "blurry",
        "watermark",
        "signature",
        "text",
        "error"
      ]
    },
    {
      "id": "anatomy",
      "name": "人体修复",
      "tags": [
        "bad anatomy",
        "bad hands",
        "extra digits",
        "fewer digits",
        "missing fingers",
        "extra limbs",
        "fused fingers",
        "mutated hands",
        "poorly drawn face",
        "deformed",
        "disfigured",
        "long neck",
        "bad proportions"
      ]
    },
    {
      "id": "photoreal",
      "name": "写实去动画",
      "tags": [
        "cartoon",
        "anime",
        "3d render",
        "cgi",
        "doll",
        "mannequin",
        "illustration",
        "painting",
        "sketch"
      ]
    },
    {
      "id": "anime",
      "name": "动漫去写实",
      "tags": [
        "photorealistic",
        "photo",
        "realistic",
        "3d",
        "cgi",
        "live action"
      ]
    },
    {
      "id": "pony",
      "name": "Pony 专用",
      "tags": [
        "score_6",
        "score_5",
        "score_4",
        "source_furry",
        "source_cartoon"
      ]
    },
    {
      "id": "male",
      "name": "男性压制（侍奉类自动加）",
      "tags": [
        "male face",
        "man",
        "boy",
        "male full body"
      ],
      "auto": true
    },
    {
      "id": "composition",
      "name": "构图修正",
      "tags": [
        "cropped",
        "cut off",
        "out of frame",
        "border",
        "letterbox"
      ]
    },
    {
      "id": "eye_lock",
      "cn": "深色瞳（压浅色眼睛）",
      "tags": [
        "blue eyes",
        "green eyes",
        "grey eyes",
        "light eyes",
        "pale eyes",
        "heterochromia",
        "glowing eyes"
      ],
      "name": "眼神锁定"
    },
    {
      "id": "modest",
      "cn": "保守服装（压露腰露脐）",
      "tags": [
        "crop top",
        "midriff",
        "navel",
        "cleavage",
        "revealing clothes",
        "see-through",
        "sheer"
      ],
      "name": "遮挡保守"
    },
    {
      "id": "smooth_face",
      "cn": "平滑柔嫩脸（压法令纹/皱纹）",
      "tags": [
        "nasolabial folds",
        "laugh lines",
        "smile lines",
        "wrinkles",
        "aged skin",
        "mature face",
        "sagging skin",
        "deep facial lines"
      ],
      "name": "磨皮去油"
    },
    {
      "id": "no_shoes",
      "cn": "不穿鞋（压鞋类）",
      "tags": [
        "(shoes:1.4)",
        "(high heels:1.5)",
        "(heels:1.5)",
        "footwear",
        "(boots:1.3)",
        "sandals",
        "(mary janes:1.4)",
        "sneakers"
      ],
      "name": "去鞋"
    }
  ]
};
window.CPS_DATA['data/recipes.json'] = {
  "version": 1,
  "items": [
    {
      "id": "R01",
      "name": "雨夜天台 · 湿衬衫",
      "model": "pony",
      "desc": "霓虹+湿身，写实感最强的一套",
      "patch": {
        "character": {
          "age": 25,
          "bust": 55,
          "skinTone": 75,
          "hairColor": "black hair",
          "hairStyle": [
            "long hair"
          ],
          "eyeColor": "brown eyes"
        },
        "clothing": {
          "top": [
            "shirt"
          ],
          "bottom": [
            "skirt"
          ],
          "coverage": 65,
          "wet": 85
        },
        "pose": {
          "tier": "light",
          "id": "L08"
        },
        "scene": {
          "location": "rainy street",
          "time": "night",
          "weather": "light rain",
          "light": [
            "neon light",
            "neon signs"
          ],
          "lightIntensity": 40
        },
        "features": {
          "expression": [
            "half-closed eyes"
          ],
          "skinState": [
            "wet",
            "sweat"
          ]
        },
        "style": {
          "realism": 70
        }
      }
    },
    {
      "id": "R02",
      "name": "晨光卧室 · 裸肩",
      "model": "pony",
      "desc": "柔和窗光，皮肤质感最好",
      "patch": {
        "character": {
          "age": 26,
          "bust": 50,
          "skinTone": 85,
          "hairColor": "brown hair",
          "hairStyle": [
            "wavy hair"
          ]
        },
        "clothing": {
          "top": [
            "camisole"
          ],
          "bottom": [
            "shorts"
          ],
          "coverage": 60
        },
        "pose": {
          "tier": "light",
          "id": "L06"
        },
        "scene": {
          "location": "bedroom",
          "time": "dawn",
          "light": [
            "window light"
          ],
          "colorTemp": 30,
          "bokeh": 70
        },
        "style": {
          "realism": 80,
          "contrast": 35
        }
      }
    },
    {
      "id": "R03",
      "name": "温泉浴衣 · 蒸汽",
      "model": "illustrious",
      "desc": "和风+水汽，注意浴衣会屏蔽内裤",
      "patch": {
        "character": {
          "age": 24,
          "bust": 60,
          "skinTone": 80,
          "hairColor": "black hair",
          "hairStyle": [
            "long hair",
            "hair up"
          ]
        },
        "clothing": {
          "top": [
            "yukata"
          ],
          "bottom": [
            "none"
          ],
          "coverage": 55,
          "wet": 60
        },
        "pose": {
          "tier": "light",
          "id": "L05"
        },
        "scene": {
          "location": "bathtub",
          "time": "night",
          "light": [
            "candlelight"
          ],
          "atmosphere": [
            "steam"
          ],
          "colorTemp": 40
        },
        "style": {
          "realism": 20
        },
        "lora": {}
      }
    },
    {
      "id": "R04",
      "name": "教室放学后 · JK",
      "model": "illustrious",
      "desc": "标准日系校园",
      "patch": {
        "character": {
          "age": 17,
          "maturity": "youthful",
          "bust": 45,
          "hairColor": "black hair",
          "hairStyle": [
            "twin tails",
            "blunt bangs"
          ]
        },
        "clothing": {
          "top": [
            "school uniform",
            "sailor shirt"
          ],
          "bottom": [
            "pleated skirt"
          ],
          "legwear": [
            "kneehighs"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L10"
        },
        "scene": {
          "location": "classroom",
          "time": "afternoon",
          "light": [
            "window light"
          ],
          "colorTemp": 20
        },
        "style": {
          "realism": 10
        },
        "lora": {}
      }
    },
    {
      "id": "R05",
      "name": "神社初詣 · 巫女",
      "model": "illustrious",
      "desc": "红白对比，背景干净",
      "patch": {
        "character": {
          "age": 22,
          "bust": 55,
          "hairColor": "black hair",
          "hairStyle": [
            "long hair",
            "hime cut"
          ],
          "eyeColor": "red eyes"
        },
        "clothing": {
          "top": [
            "kimono"
          ],
          "bottom": [
            "none"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L01"
        },
        "scene": {
          "location": "shrine",
          "time": "afternoon",
          "weather": "snow",
          "light": [
            "natural light"
          ],
          "atmosphere": [
            "snowflakes"
          ]
        },
        "style": {
          "realism": 15
        }
      }
    },
    {
      "id": "R06",
      "name": "泳池边 · 比基尼",
      "model": "pony",
      "desc": "高饱和夏日感",
      "patch": {
        "character": {
          "age": 24,
          "bust": 60,
          "skinTone": 50,
          "hairColor": "blonde hair",
          "hairStyle": [
            "ponytail"
          ]
        },
        "clothing": {
          "top": [
            "bikini top"
          ],
          "bottom": [
            "swim shorts"
          ],
          "coverage": 35
        },
        "pose": {
          "tier": "light",
          "id": "L03"
        },
        "scene": {
          "location": "swimming pool",
          "time": "noon",
          "light": [
            "natural light"
          ],
          "colorTemp": 45
        },
        "style": {
          "realism": 75,
          "saturation": 80
        }
      }
    },
    {
      "id": "R07",
      "name": "私影写真 · 白衬衫",
      "model": "pony",
      "desc": "最稳的写实人像配方",
      "patch": {
        "character": {
          "age": 26,
          "maturity": "mature face",
          "bust": 50,
          "skinTone": 80,
          "hairColor": "black hair",
          "hairStyle": [
            "straight hair",
            "hair up"
          ]
        },
        "clothing": {
          "top": [
            "shirt"
          ],
          "bottom": [
            "none"
          ],
          "coverage": 45,
          "damage": 30
        },
        "pose": {
          "tier": "light",
          "id": "L09"
        },
        "scene": {
          "location": "bedroom",
          "time": "afternoon",
          "light": [
            "softbox"
          ],
          "bokeh": 80
        },
        "style": {
          "realism": 85,
          "contrast": 40,
          "renderDetail": 80
        }
      }
    },
    {
      "id": "R08",
      "name": "霓虹巷 · 皮衣",
      "model": "pony",
      "desc": "赛博朋克冷色调",
      "patch": {
        "character": {
          "age": 25,
          "bust": 55,
          "skinTone": 60,
          "hairColor": "silver hair",
          "hairStyle": [
            "short hair"
          ]
        },
        "clothing": {
          "top": [
            "leather jacket"
          ],
          "bottom": [
            "jeans"
          ],
          "material": [
            "leather"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L02"
        },
        "scene": {
          "location": "neon alley",
          "time": "late night",
          "light": [
            "neon signs"
          ],
          "colorTemp": -70
        },
        "style": {
          "realism": 70,
          "saturation": 75
        }
      }
    },
    {
      "id": "R09",
      "name": "图书馆 · 眼镜",
      "model": "illustrious",
      "desc": "安静气质向",
      "patch": {
        "character": {
          "age": 23,
          "bust": 50,
          "hairColor": "black hair",
          "hairStyle": [
            "braid"
          ]
        },
        "clothing": {
          "top": [
            "blouse"
          ],
          "bottom": [
            "long skirt"
          ],
          "accessory": [
            "glasses"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L10"
        },
        "scene": {
          "location": "library",
          "time": "afternoon",
          "light": [
            "window light"
          ]
        },
        "style": {
          "realism": 20
        }
      }
    },
    {
      "id": "R10",
      "name": "厨房围裙 · 晨",
      "model": "pony",
      "desc": "日常居家感",
      "patch": {
        "character": {
          "age": 27,
          "bust": 55,
          "hairColor": "brown hair",
          "hairStyle": [
            "bun"
          ]
        },
        "clothing": {
          "top": [
            "apron"
          ],
          "bottom": [
            "none"
          ],
          "coverage": 40
        },
        "pose": {
          "tier": "light",
          "id": "L01"
        },
        "scene": {
          "location": "kitchen",
          "time": "dawn",
          "light": [
            "window light"
          ],
          "colorTemp": 35
        },
        "style": {
          "realism": 80
        }
      }
    },
    {
      "id": "R11",
      "name": "婚纱 · 教堂",
      "model": "illustrious",
      "desc": "反差向：圣洁场景 + 私密姿态",
      "patch": {
        "character": {
          "age": 25,
          "bust": 55,
          "hairColor": "white hair",
          "hairStyle": [
            "long hair"
          ]
        },
        "clothing": {
          "top": [
            "wedding dress"
          ],
          "bottom": [
            "none"
          ],
          "headwear": [
            "veil"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L05"
        },
        "scene": {
          "location": "church",
          "time": "afternoon",
          "light": [
            "window light"
          ],
          "volumetrics": 70
        },
        "style": {
          "realism": 25
        }
      }
    },
    {
      "id": "R12",
      "name": "电车 · 制服",
      "model": "illustrious",
      "desc": "拥挤感、偷拍视角",
      "patch": {
        "character": {
          "age": 20,
          "bust": 50,
          "hairColor": "black hair",
          "hairStyle": [
            "ponytail"
          ]
        },
        "clothing": {
          "top": [
            "school uniform"
          ],
          "bottom": [
            "pleated skirt"
          ],
          "legwear": [
            "pantyhose"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L02"
        },
        "scene": {
          "location": "train interior",
          "time": "afternoon",
          "light": [
            "fluorescent"
          ],
          "view": [
            "from below"
          ]
        },
        "style": {
          "realism": 15
        }
      }
    },
    {
      "id": "R13",
      "name": "健身房 · 运动",
      "model": "pony",
      "desc": "汗水+紧身衣",
      "patch": {
        "character": {
          "age": 25,
          "muscle": 60,
          "bust": 55,
          "skinTone": 65,
          "hairColor": "black hair",
          "hairStyle": [
            "ponytail"
          ]
        },
        "clothing": {
          "top": [
            "sports bra"
          ],
          "bottom": [
            "leggings"
          ],
          "coverage": 45
        },
        "pose": {
          "tier": "light",
          "id": "L04"
        },
        "scene": {
          "location": "office",
          "time": "noon",
          "light": [
            "fluorescent"
          ]
        },
        "features": {
          "skinState": [
            "sweat",
            "sweat drop"
          ]
        },
        "style": {
          "realism": 80,
          "contrast": 70
        }
      }
    },
    {
      "id": "R14",
      "name": "和室 · 浴衣落肩",
      "model": "illustrious",
      "desc": "日式留白构图",
      "patch": {
        "character": {
          "age": 24,
          "bust": 60,
          "hairColor": "black hair",
          "hairStyle": [
            "hair up"
          ]
        },
        "clothing": {
          "top": [
            "yukata"
          ],
          "bottom": [
            "none"
          ],
          "coverage": 50
        },
        "pose": {
          "tier": "light",
          "id": "L05"
        },
        "scene": {
          "location": "japanese garden",
          "time": "sunset",
          "light": [
            "golden hour"
          ]
        },
        "style": {
          "realism": 20
        }
      }
    },
    {
      "id": "R15",
      "name": "病栋 · 护士",
      "model": "illustrious",
      "desc": "白制服+冷光",
      "patch": {
        "character": {
          "age": 24,
          "bust": 58,
          "hairColor": "brown hair",
          "hairStyle": [
            "bun"
          ]
        },
        "clothing": {
          "top": [
            "nurse outfit"
          ],
          "bottom": [
            "miniskirt"
          ],
          "headwear": [
            "nurse cap"
          ],
          "legwear": [
            "pantyhose"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L10"
        },
        "scene": {
          "location": "office",
          "time": "late night",
          "light": [
            "fluorescent"
          ],
          "colorTemp": -30
        },
        "style": {
          "realism": 15
        }
      }
    },
    {
      "id": "R16",
      "name": "女仆 · 起居室",
      "model": "illustrious",
      "desc": "经典女仆装",
      "patch": {
        "character": {
          "age": 22,
          "bust": 55,
          "hairColor": "blonde hair",
          "hairStyle": [
            "twin tails"
          ]
        },
        "clothing": {
          "top": [
            "maid outfit"
          ],
          "bottom": [
            "pleated skirt"
          ],
          "headwear": [
            "maid headdress"
          ],
          "legwear": [
            "thighhighs"
          ]
        },
        "pose": {
          "tier": "light",
          "id": "L05"
        },
        "scene": {
          "location": "living room",
          "time": "afternoon",
          "light": [
            "window light"
          ]
        },
        "style": {
          "realism": 15
        }
      }
    },
    {
      "id": "R21",
      "name": "海边黄昏 · 湿发",
      "model": "pony",
      "desc": "黄金时刻 + 湿身",
      "patch": {
        "character": {
          "age": 24,
          "bust": 58,
          "skinTone": 55,
          "hairColor": "brown hair",
          "hairStyle": [
            "wet hair",
            "long hair"
          ]
        },
        "clothing": {
          "top": [
            "bikini top"
          ],
          "bottom": [
            "swim shorts"
          ],
          "coverage": 30,
          "wet": 90
        },
        "pose": {
          "tier": "light",
          "id": "L12"
        },
        "scene": {
          "location": "beach",
          "time": "sunset",
          "light": [
            "golden hour",
            "backlighting"
          ],
          "colorTemp": 80
        },
        "style": {
          "realism": 80,
          "saturation": 75
        }
      }
    },
    {
      "id": "R24",
      "name": "旗袍 · 夜宴",
      "model": "illustrious",
      "desc": "国风+高对比光影",
      "patch": {
        "character": {
          "age": 26,
          "maturity": "mature face",
          "bust": 58,
          "hairColor": "black hair",
          "hairStyle": [
            "hair up",
            "sidelocks"
          ]
        },
        "clothing": {
          "bottom": [
            "china dress"
          ],
          "coverage": 70
        },
        "pose": {
          "tier": "light",
          "id": "L03"
        },
        "scene": {
          "location": "hotel room",
          "time": "night",
          "light": [
            "candlelight"
          ],
          "colorTemp": 50,
          "lightIntensity": 38
        },
        "style": {
          "realism": 25,
          "saturation": 70
        }
      }
    }
  ]
};
