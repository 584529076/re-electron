/* 提示词引擎：字段 → tag → 预算裁剪 → 提示词 / 采样参数 / 工作流 */
(function (g) {
  'use strict';

  // ---------- 工具 ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function segOf(field, v) {
    if (!field.map) return [];
    for (const m of field.map) if (v >= m.from && v <= m.to) return m.tags || [];
    return [];
  }

  function lerpMap(v, min, max, outMin, outMax) {
    const t = (v - min) / Math.max(1, max - min);
    return outMin + (outMax - outMin) * Math.min(1, Math.max(0, t));
  }

  // ---------- 规则仲裁 ----------
  // lastTouched: 最近操作的模块名，用于"用户最后操作赢"
  function evalRules(state, data, lastTouched) {
    const disabled = new Set();   // "fieldId" 被禁用
    const cleared = new Set();    // "module.fieldId" 输出时忽略
    const injected = [];          // {tag, src, pri}
    const valueKeep = [];         // {field, keep:[...]} 同字段取值互斥（如连衣裙不允许再叠裤子）
    const hits = [];              // 命中的规则，供 UI 显示

    for (const r of data.clothing.rules || []) {
      let hit = false;
      const f = r.if;
      if (f.field) {
        const v = state.clothing[f.field] || [];
        // 多个条件是「同时满足」，不是后者覆盖前者（否则 notIncludes + notEmpty 会互相吃掉）
        let sub = true;
        if (f.includes) sub = Array.isArray(v) ? (v.includes(f.includes) && f.includes !== 'none') : v === f.includes;
        if (sub && f.notIncludes) sub = Array.isArray(v) ? !v.includes(f.notIncludes) : v !== f.notIncludes;
        if (sub && f.notEmpty) sub = Array.isArray(v) ? v.filter((x) => x !== 'none').length > 0 : !!v;
        hit = sub;
      }
      if (f.slider) {
        const sv = state.clothing[f.slider];
        if (sv == null) continue;   // 没设值就不参与规则（否则 null<20 会被当成 0 触发）
        if (f.lt != null) hit = sv < f.lt;
        if (f.gt != null) hit = sv > f.gt;
      }
      if (!hit) continue;
      hits.push({ id: r.id, label: r.label });
      (r.then.disable || []).forEach((x) => disabled.add(x));
      (r.then.clear || []).forEach((x) => cleared.add('clothing.' + x));
      (r.then.inject || []).forEach((t) => injected.push({ tag: t, src: 'clothing', pri: 1 }));
      if (r.then.only) valueKeep.push({ field: r.then.only.field, keep: r.then.only.keep || [] });
    }
    // 覆盖度 < 20 时强制无衣着，但保留袜
    return { disabled, cleared, injected, valueKeep, hits };
  }

  // ---------- 收集 ----------
  function collect(state, data, rulesOut) {
    const out = [];
    const push = (tags, src, pri, weight) => {
      for (const t of tags) {
        if (!t) continue;
        const clean = String(t).trim();
        if (!clean) continue;
        out.push({ tag: clean, src, pri, weight: weight || 1 });
      }
    };

    // 人物
    for (const f of data.characters.fields) {
      if (state._off && state._off['character.' + f.id]) continue;   // 被开关停用：保留值但不输出
      const v = state.character[f.id];
      if (v == null) continue;
      if (f.type === 'slider') push(segOf(f, v), 'character', f.priority);
      else if (f.type === 'color') {
        // 训练素材：发色加权重，否则黑发会被画成墨绿/青黑
        push([state._trainSolo && v ? '(' + v + ':1.15)' : v], 'character', f.priority);
      }
      else if (f.type === 'select') {
        const oo = (f.options || []).find((x) => x.v === v);
        push(v !== 'none' ? (oo && oo.tags ? oo.tags : [v]) : [], 'character', f.priority);
      }
      else if (f.type === 'multi') push(v, 'character', f.priority);
    }

    // 服装（受规则影响）
    // 训练素材模式：整个服装模块跳过。不跳过的话「no-clothing 词」和
    // 「white shirt」会同时进正向，模型随机选一个，一半图会穿衣服。
    const _tmCloth = trainMode(state);
    const colorMap = {};
    for (const f of (_tmCloth && _tmCloth.nude ? [] : data.clothing.fields)) {
      if (f.type !== 'color' || !f.forField) continue;
      const cv = state.clothing[f.id];
      if (!cv) continue;
      if (rulesOut.disabled.has(f.forField) || rulesOut.cleared.has('clothing.' + f.forField)) continue;
      colorMap[f.forField] = cv;
    }
    for (const f of (_tmCloth && _tmCloth.nude ? [] : data.clothing.fields)) {
      if (state._off && state._off['clothing.' + f.id]) continue;   // 被开关停用
      if (rulesOut.disabled.has(f.id) && f.id !== 'coverage') continue;
      if (rulesOut.cleared.has('clothing.' + f.id)) continue;
      const v = state.clothing[f.id];
      if (v == null) continue;
      if (_tmCloth && _tmCloth.nude) continue;   // 训练无衣着：服装一律不输出
      if (f.type === 'slider') push(segOf(f, v), 'clothing', f.priority);
      else if (f.type === 'multi') {
        // 'none' = 明确「不穿」，不输出任何词（也不能把 none 本身当 tag）
        let vals = (v || []).filter((x) => x !== 'none');
        if (!vals.length) continue;
        const vk = (rulesOut.valueKeep || []).find((k) => k.field === f.id);
        if (vk) vals = vals.filter((x) => vk.keep.includes(x));
        const col = colorMap[f.id];
        if (col && vals.length && vals[0] !== 'none' && vals[0] !== 'barefoot' && !/^no /.test(vals[0])) {
          vals = vals.slice();
          vals[0] = col + ' ' + vals[0];   // 只给第一件上色
        }
        push(vals, 'clothing', f.priority);
      } else if (f.type === 'color') {
        // 颜色已经在上面并进服装词，这里不重复输出
      }
    }
    push(rulesOut.injected.map((x) => x.tag), 'clothing', 1);

    // 姿势
    const tierData = data.poses[state.pose.tier];
    const pose = tierData && tierData.poses.find((p) => p.id === state.pose.id);
    // 构图滑条：即使没选姿势（训练素材模式固定站姿）也必须生效，
    // 否则「上半身 / 全身」这类景别永远不会进提示词。
    if (tierData) {
      const sliders2 = (tierData.commonSliders || []).concat((pose && pose.sliders) || []);
      for (const s of sliders2) {
        const v = state.pose.sliders[s.id];
        if (v == null) continue;
        for (const m of (s.map || [])) if (v >= m.from && v <= m.to) push(m.tags, 'pose', 2);
      }
    }
    // 训练素材：景别互斥。全身/七分身必须压掉特写，否则模型一把大胸就裁成躯干
    if (state._trainSolo) {
      const cd = state.pose.sliders && state.pose.sliders.camDist;
      if (cd != null) {
        if (cd >= 76) {
          state.__trainFrameNeg = 'close-up, cropped, out of frame, portrait, upper body, cowboy shot, knees up only, head out of frame, faceless';
        } else if (cd >= 51) {
          state.__trainFrameNeg = 'close-up, extreme close-up, cropped, head out of frame, faceless';
        } else if (cd <= 25) {
          state.__trainFrameNeg = 'full body, feet visible, wide shot, distant';
        } else {
          state.__trainFrameNeg = 'extreme close-up, cropped, faceless';
        }
      }
    }
    if (pose) {
      // 姿势自带词里若有视角词（from above / from below / high angle…），会与「镜头高度」滑条打架，这里剔除
      const VIEW_WORDS = ['from above', 'from below', 'high angle', 'low angle', 'from side', 'dutch angle', 'from front'];
      const _camStr = ((state.scene && state.scene.view) || []).join(' ').toLowerCase();
      const _backCam = /behind|from back|rear|back view/.test(_camStr);
      const _sideCam = /profile|from side|side view/.test(_camStr);
      let _ptags = pose.tags.filter((t) => VIEW_WORDS.indexOf(String(t).toLowerCase()) < 0);
      // 机位选了背面/侧面，姿势里的「正对镜头」必须撤掉，否则模型两边听一半
      if (_backCam || _sideCam) {
        _ptags = _ptags.filter((t) => !/facing (the )?viewer|looking at viewer|facing forward/i.test(String(t)));
      }
      push(_ptags, 'pose', 1);
      // 姿势子选项（男方位置 / 朝向）
      const subsState = state.pose.subs || {};
      const subDefs = (pose.subs && pose.subs.length ? pose.subs : (tierData.subs || []));
      for (const sb of subDefs) {
        const val = subsState[sb.id];
        if (!val || val === 'none') continue;
        const opt = (sb.options || []).find((o) => o.v === val);
        if (opt && opt.tags && opt.tags.length) push(opt.tags, 'pose', 1);
        // 二级变体（如男站立 → 双手按头 / 扶脸 / 垂手）
        if (sb.id === 'posture' && opt && opt.variants) {
          const vv = subsState.postureVariant;
          const vo = opt.variants.find((x) => x.v === vv);
          if (vo && vo.tags && vo.tags.length) push(vo.tags, 'pose', 1);
        }
      }
      if (pose.male && tierData.maleRule) {
        const view = (state.pose && state.pose.view) || 'third';
        if (view === 'pov') {
          // 第一人称：从男方视角看，男方只露手/躯干
          let mpos = tierData.maleRule.positive;
          const oo = (state.pose.subs || {}).orient;
          if (oo === 'back') mpos = mpos.filter((t) => String(t).toLowerCase() !== 'pov');
          push(mpos, 'pose', 2);
        } else {
          // 旁观视角（默认）：两个人都在画面里，才看得清是什么体位
          push(['1boy', 'hetero', 'sex', 'visible male body'], 'pose', 2);
        }
      }

    }

    // 场景
    for (const f of data.scenes.fields) {
      if (state._off && state._off['scene.' + f.id]) continue;   // 被开关停用：保留值但不输出
      const v = state.scene[f.id];
      if (v == null) continue;
      if (f.type === 'slider') push(segOf(f, v), 'scene', f.priority);
      else if (f.type === 'select') {
        const oo = (f.options || []).find((x) => x.v === v);
        push(v !== 'none' ? (oo && oo.tags ? oo.tags : [v]) : [], 'scene', f.priority);
      }
      else if (f.type === 'multi') push(v, 'scene', f.priority);
    }

    // 特征
    for (const f of data.features.fields) {
      if (state._off && state._off['feature.' + f.id]) continue;   // 被开关停用：保留值但不输出
      const v = state.feature[f.id];
      if (v == null) continue;
      if (f.type === 'slider') {
        if (f.id === 'pregnant' && !(state.feature.bodyMark || []).includes('pregnant')) continue;
        push(segOf(f, v), 'feature', f.priority);
      } else if (f.type === 'select') {
        const oo = (f.options || []).find((x) => x.v === v);
        push(v !== 'none' ? (oo && oo.tags ? oo.tags : [v]) : [], 'feature', f.priority);
      }
      else if (f.type === 'multi') push(v, 'feature', f.priority);
    }

    // 画风
    const model = data.models.models.find((m) => m.id === state.model)
      || data.models.models.find((m) => m.file === state.model)
      || data.models.models[0];
    for (const f of data.styles.fields) {
      if (state._off && state._off['style.' + f.id]) continue;   // 被开关停用：保留值但不输出
      const v = state.style[f.id];
      if (f.id === 'artists' && model && model.supportsArtist === false) continue;
      if (v == null) continue;
      if (f.type === 'slider') push(segOf(f, v), 'style', f.priority);
      else if (f.type === 'select') {
        const oo = (f.options || []).find((x) => x.v === v);
        push(v !== 'none' ? (oo && oo.tags ? oo.tags : [v]) : [], 'style', f.priority);
      }
      else if (f.type === 'multi') push(v, 'style', f.priority);
    }

    return out;
  }

  // ---------- token 估算（CLIP 近似） ----------
  function estTokens(str) {
    if (!str) return 0;
    const parts = str.split(',').map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (const p of parts) {
      const words = p.split(/\s+/).filter(Boolean).length;
      const chars = p.length;
      n += Math.max(Math.ceil(chars / 4.2), Math.ceil(words * 1.25));
    }
    return n + 2;
  }

  // ---------- 去重 ----------
  function normTag(t) {
    return String(t).toLowerCase().replace(/[()]/g, '').replace(/:\d+(\.\d+)?$/, '').trim();
  }

  function dedupe(list) {
    const seen = new Map();
    for (const it of list) {
      const key = normTag(it.tag);
      if (!seen.has(key)) seen.set(key, it);
      else {
        const prev = seen.get(key);
        if (it.pri < prev.pri) seen.set(key, it);
      }
    }
    return [...seen.values()];
  }

  // ---------- 采样参数 ----------
  function computeParams(state, data) {
    const model = data.models.models.find((m) => m.id === state.model)
      || data.models.models.find((m) => m.file === state.model)
      || data.models.models[0] || {};
    const s = model.sampler;
    let steps = s.steps, cfg = s.cfg;
    const styleFields = data.styles.fields;
    const rd = styleFields.find((f) => f.id === 'renderDetail');
    const rdV = state.style.renderDetail;
    if (rd && rd.param && rdV != null) steps = Math.round(lerpMap(rdV, 0, 100, rd.param.steps[0], rd.param.steps[1]));
    const real = styleFields.find((f) => f.id === 'realism');
    if (real && real.param && real.param.cfg && state.style.realism != null) cfg = lerpMap(state.style.realism, 0, 100, real.param.cfg[0], real.param.cfg[1]);
    const sty = styleFields.find((f) => f.id === 'stylization');
    if (sty && sty.param && sty.param.cfgInverse && state.style.stylization != null) cfg -= lerpMap(state.style.stylization, 0, 100, 0, 1.2);
    // 训练素材 + 非全身构图：人物占画面越大，色彩越容易溢出，CFG 降 1 压住。
    // 全身构图人物小，权重被摊开，不用降。
    // 2026-11-15 实测：降 CFG 会让七分身构图的背景压不住纯白（出灰墙/地板），
    // 而现在训练素材只用七分身和全身两档、色彩溢出已经不出现，所以不再降。
    // if (state._trainSolo) {
    //   const _cd = state.pose && state.pose.sliders && state.pose.sliders.camDist;
    //   if (_cd != null && _cd < 76) cfg -= 1;
    // }
    return {
      steps: Math.max(12, Math.min(50, steps)),
      cfg: Math.max(1.5, Math.min(12, Math.round(cfg * 10) / 10)),
      sampler: s.sampler, scheduler: s.scheduler,
      // 设置面板可以覆盖分辨率（配置文件里的「默认分辨率」）
      width: state.overrideW || s.width,
      height: state.overrideH || s.height,
      model: model.file
    };
  }

  // ---------- 负面 ----------
  // 训练素材模式：以 state._trainSet 为准（用户选了什么就是什么），
  // 不依赖临时标志位——标志位在页面重载 / 中途改动后会丢，导致裸着出衣服。
  // 「用服装页当前设定 / 用场景页设定」在对应页签是空的时候等于没选：
  // 服装页空 → 当作无衣着处理（否则模型自由发挥，一批里穿着忽有忽无）；
  // 场景页空 → 当作纯白背景处理（否则环境被学进角色）。
  function clothingEmpty(state) {
    const c = state.clothing || {};
    return !Object.keys(c).some((k) => {
      const v = c[k];
      if (Array.isArray(v)) return v.filter((x) => x !== 'none').length > 0;
      return v != null && v !== '' && v !== 'none';
    });
  }
  function sceneEmpty(state) {
    const s = state.scene || {};
    return !Object.keys(s).some((k) => {
      if (k === 'view') return false;
      const v = s[k];
      if (Array.isArray(v)) return v.filter((x) => x !== 'none').length > 0;
      return v != null && v !== '' && v !== 'none';
    });
  }
  function trainMode(state) {
    const ts = state._trainSet;
    if (!ts || !state._trainSolo) return null;
    const cloth = (ts.cloth || ['nude'])[0];
    const bg = (ts.bg || ['solid'])[0];
    const nude = cloth === 'nude' || (cloth === 'keep' && clothingEmpty(state));
    const solidBg = bg === 'solid' || (bg === 'keep' && sceneEmpty(state));
    return { nude: nude, solidBg: solidBg, clothFallback: cloth === 'keep' && nude, bgFallback: bg === 'keep' && solidBg };
  }

  function buildNegative(state, data) {
    const model = data.models.models.find((m) => m.id === state.model)
      || data.models.models.find((m) => m.file === state.model)
      || data.models.models[0] || {};

    // 训练素材：精简负向。原来堆了 1700 字的负向，权重词一多就会把色彩空间推歪
    // （压蓝绿 → 画面偏红紫）。这批图需求很简单，十几条足够。
    if (state._trainSolo) {
      var _tmN = trainMode(state) || {};
      var _nude = !!_tmN.nude;
      var _solid = !!_tmN.solidBg;
      var _cd = state.pose && state.pose.sliders ? state.pose.sliders.camDist : null;
      var neg = [
        'worst quality, low quality, lowres, blurry, jpeg artifacts',
        'bad anatomy, bad hands, extra digits, fused fingers, extra limbs',
        '2girls, multiple girls, 1boy, male, penis, pov',
        // 同一角色两个视角并排/角色表：实测俯视与背面各出过 1/4–1/5，这种图进训练集会教坏「并排双人」
        '(multiple views:1.4), (split view:1.4), (side by side:1.3), (character sheet:1.4), (duplicate:1.3), cloned face, twins, extra person'
      ];
      // ★ 姿态压制放在第 5 位（要紧靠前面）：负向太长时 CLIP 只吃前 ~231 token，
      // 排在尾部的「弯腰/后仰/走路」实测完全不生效（侧面 10 张里 10 张姿态失控）。
      var _angN = (state.scene && Array.isArray(state.scene.view)) ? state.scene.view : [];
      var _exprN = (state.feature && Array.isArray(state.feature.expression)) ? state.feature.expression : [];
      var _angTxt = (_angN || []).join(' ').toLowerCase();
      var _isSide = _angTxt.indexOf('side') >= 0 || _angTxt.indexOf('profile') >= 0;
      var _poseNeg = '(leaning forward:1.3), (bent over:1.3), (leaning back:1.25), head tilted back, looking up, walking, mid-stride, slouching, crouching, contortion, sitting, kneeling, lying, spread legs, arms up, hand on hip, dynamic pose, holding, prop';
      if (_isSide) _poseNeg += ', neck craned, twisted torso';
      if (!_angN.length && _exprN.indexOf('looking away') < 0) _poseNeg += ', looking down, head down, tilted head, profile';
      if (_angTxt.indexOf('below') >= 0) _poseNeg += ', (from above:1.35), (high angle:1.3), top-down, eye level, straight on';
      // 俯视的地面投影：裸词 shadow 压不住（实测 5/5 都带），必须加权点名
      if (_angTxt.indexOf('above') >= 0) _poseNeg += ', (drop shadow:1.4), (ground shadow:1.35), (cast shadow:1.35), (shadow:1.3), reflection, reflection on floor, contact shadow';
      neg.push(_poseNeg);
      // 体脂：低体脂必须主动压肥胖。底模（waiNSFW Illustrious）默认偏丰满，
      // 正向只写 slim/slender 压不住，负向不点名就会出厚腹和粗腿。
      var _bf = state.character && state.character.bodyFat;
      if (_bf != null) {
        if (_bf <= 20) neg.push('fat, chubby, plump, thick thighs, belly, soft belly, obese, wide hips');
        else if (_bf <= 35) neg.push('fat, chubby, obese, flabby');
        else if (_bf <= 50) neg.push('obese, flabby');
      }
      if (_nude) neg.push('clothes, shirt, bra, panties, underwear, swimsuit');
      // 背景：这里是素材能不能用的关键。只压 bedroom/indoors 不够 ——
      // 七分身构图下底模会自己补灰墙、地板、暗角和投影（实测纯白背景只有一半成立）。
      if (_solid) {
        neg.push('bedroom, room interior, furniture, bed, window, curtains, door, wall, ' +
          'concrete wall, studio backdrop, gray background, gradient background, colored background, ' +
          'floor, ground, shadow on wall, cast shadow, vignetting, indoors, scenery, detailed background, bokeh');
      }
      neg.push('watermark, signature, text, censored, cropped, out of frame, faceless, deformed');
      // 皮肤：白底 + 无衣着时底模会加油光/水感，训练集里会变成「皮肤天生油亮」
      neg.push('water drops, sweat, wet skin, glossy skin, shiny skin, oily skin, specular highlights');
      if (_cd != null) {
        if (_cd >= 76) neg.push('close-up, upper body');
        else if (_cd >= 51) neg.push('close-up, extreme close-up, cropped');
        else neg.push('full body, cropped');
      }
      return [...new Set(neg.join(', ').split(/,\s*/).filter(Boolean))].join(', ');
    }

    // 底模条目里没写 negativeBase（例如首次自动扫描登记进来的）时用这套通用质量负向，否则负向会空掉
    const NEG_BASE_FALLBACK = 'worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, extra limbs, fused fingers, mutated hands, poorly drawn face, poorly drawn hands, deformed, disfigured, blurry, jpeg artifacts, watermark, signature, text, error, censored';
    const parts = [model.negativeBase || NEG_BASE_FALLBACK];
    let active = (state.negativeGroups || ['base', 'anatomy']).slice();
    // 男性压制改为自动：只要当前体位需要男方出场（侍奉/性爱类），就自动加上，不用手选
    const poseNow = (() => {
      const td = data.poses[state.pose.tier];
      return td && td.poses.find((p) => p.id === state.pose.id);
    })();
    if (poseNow && poseNow.male && active.indexOf('male') < 0) active.push('male');
    for (const gid of active) {
      const g = data.negatives.groups.find((x) => x.id === gid);
      if (g) parts.push(g.tags.join(', '));
    }
    // 模型自带的强制负面组（数据驱动：models.json 的 forceNegGroups）
    // 原来写死 if (model.id === 'pony')，加第三个模型就失效了。
    const _forced = (model && Array.isArray(model.forceNegGroups)) ? model.forceNegGroups : [];
    for (const gid of _forced) {
      if (active.includes(gid)) continue;
      const pg = data.negatives.groups.find((x) => x.id === gid);
      if (pg) parts.push(pg.tags.join(', '));
    }
    // 有男性局部的姿势 → 压制男性
    const tierData = data.poses[state.pose.tier];
    const pose = tierData && tierData.poses.find((p) => p.id === state.pose.id);
    if (pose && pose.male && tierData.maleRule && ((state.pose && state.pose.view) || 'third') === 'pov') {
      // 只有第一人称视角才压制男性全身；旁观视角必须画出男方，否则看不出体位
      parts.push(tierData.maleRule.negative.map((t) => '(' + t + ':' + (tierData.maleRule.negativeWeight || 1.3) + ')').join(', '));
    }
    // 体脂：选低的时候必须主动压制肥胖。底模（waiNSFW/Illustrious）训练数据偏丰满，
    // 只靠正向 skinny/slender 压不住，负向不点名就会出厚腹、粗腿、赘肉。
    const fatV = state.character && state.character.bodyFat;
    if (fatV != null) {
      if (fatV <= 8) {
        // 极瘦档：全量压制
        parts.push('(fat:1.2), (chubby:1.15), (plump:1.1), (thick thighs:1.1), (belly:1.15), (soft belly:1.15), flabby, (wide hips:1.1), (obese:1.2), chubby legs');
      } else if (fatV <= 20) {
        // 纤细档：只压明显的胖，保留正常肉感（别压成骨感）
        parts.push('(fat:1.1), chubby, (thick thighs:1.05), (belly:1.1), obese, flabby');
      } else if (fatV <= 40) {
        parts.push('chubby, obese, flabby');
      }
    }
    // 腰：低腰值时再压肚腩
    const waistV = state.character && state.character.waist;
    if (waistV != null && waistV <= 20) {
      parts.push('(belly:1.1), (soft belly:1.1), pudgy, belly fat');
    }
    // 画面人数强锁：按选定人数反向压制多出来的人（否则模型经常多画一个人）
    (function () {
      const cw2 = state.feature && state.feature.crowd;
      if (!cw2) return;
      if (cw2 === 'crowd' || /multiple/i.test(cw2)) return;   // 群像/人群不压
      let nGirls = 1, nBoys = 0;
      const gm = /(\d+)girls/.exec(cw2);
      const bm = /(\d+)boys/.exec(cw2);
      if (gm) nGirls = +gm[1];
      if (bm) nBoys = +bm[1];
      else if (/1girl,\s*1boy/.test(cw2)) nBoys = 1;
      const extra = [];
      // 多出来的人
      if (nGirls <= 1) extra.push('2girls', '(multiple girls:1.3)', 'extra girl', 'another woman', 'second girl', 'twin');
      else if (nGirls === 2) extra.push('3girls', '(multiple girls:1.2)', 'extra girl', 'third girl');
      if (nBoys === 0) extra.push('1boy', 'male', 'man', 'penis', '(male face:1.3)', 'male hand', 'male arm');
      else if (nBoys === 1) extra.push('2boys', '(multiple boys:1.2)', 'extra boy', 'second man', 'third person');
      else if (nBoys === 2) extra.push('3boys', 'extra boy', 'third man');
      extra.push('(multiple views:1.25)', '(split view:1.25)', '(two views:1.2)', 'character sheet', 'reference sheet', 'duplicate', 'cloned face', 'model sheet', 'same character twice');
      parts.push(extra.join(', '));
    })();

    // 训练素材模式：素材里出现两个人 / 多视角，这批就废了，必须明确压掉
    if (state._trainSolo) {
      if (state.__trainFrameNeg) parts.push(state.__trainFrameNeg);
      parts.push('(2girls:1.5), (multiple girls:1.5), (two girls:1.4), (3girls:1.3), 2girls, multiple girls, extra girl, second person, another woman, group, crowd, (multiple views:1.5), (split view:1.5), (character sheet:1.45), (reference sheet:1.45), (duplicate:1.35), (cloned face:1.3), (two views:1.4), (side by side:1.3), twins, extra person, same character twice, model sheet, turnaround');
      // 训练素材不要男性、不要 POV 视角、不要各种非站姿（模型会自作主张加手加腿）
      parts.push('1boy, male, man, penis, pov, male hand, disembodied hand, male arm, kneeling, sitting, lying, on back, spread legs');
      parts.push('bent over, leaning forward, bending, crouching, contortion, holding object, holding, weapon, jewelry, necklace, prop, from behind');
      var _tmb2 = trainMode(state);
      if (_tmb2 && _tmb2.solidBg) {
        parts.push('bedroom, room interior, furniture, bed, bed sheet, window, curtains, door, wall texture, floor, outdoors, scenery, detailed background, indoors, lighting shadow on wall, green background, chroma key green, colored background, gradient background, pink background, blue background, dark background');
      }
    }
    // 无衣着素材：压掉贴身衣物，否则会画出半脱/遮挡
    var _tm = trainMode(state);
    if (_tm) {
      // 白底容易把皮肤烘成纯白，压过曝和缺细节的皮
      parts.push('overexposed, blown out highlights, washed out, flat lighting, loss of detail, featureless skin');
    }
    if (_tm && _tm.nude) {
      parts.push('clothes, clothing, shirt, bra, panties, underwear, skirt, dress, swimsuit, bikini, pantyhose, socks, straps, one-piece swimsuit, leotard, apron, towel');
      // 干净皮肤：压水珠、油光、偏色、色差
      parts.push('water drops, sweat, wet skin, glossy skin, shiny skin, oily skin, color fringing, chromatic aberration, color banding');
    }
    // 晒痕：关着的时候主动压制（写实模型很容易自己长出晒痕/肤色分界）
    const tan = state.character && state.character.tanLines;
    if (!tan) {
      parts.push('tan lines, (sun tan:1.1), tanline, uneven skin tone, two-tone skin');
    }
    // 用户明确要求不加晒痕时，正向也可能被模型塞进去，这里再点名压一次
    if (tan >= 1) {
      parts.push('uneven skin tone, patchy tan');
    }
    return [...new Set(parts.filter(Boolean).join(', ').split(/,\s*/))].join(', ');
  }

  // ---------- 主构建 ----------
  function build(state, data, opts) {
    opts = opts || {};
    // 模型必须在预算之前解析：SDXL 的 CLIP 预算是 200，SD1.5 只有 150，
    // 预算写死 200 时 SD1.5 会吃掉约 1/4 根本不生效的词。
    const model = data.models.models.find((m) => m.id === state.model)
      || data.models.models.find((m) => m.file === state.model)
      || data.models.models[0];
    const budget = opts.budget || (model && model.tokenBudget) || 200;
    const rulesOut = evalRules(state, data, state._lastTouched);
    let list = dedupe(collect(state, data, rulesOut));
    // 训练素材：把人物字段的权重全抹掉。训练模式本身已有一批加权词，
    // 人物设定再叠（美貌/瞳色/发色/腰围都带权重）会累计到十几个，导致色彩溢出。
    // 训练素材里人物是唯一主体，裸词完全够用。
    // 输出页里被点灰的词：不高亮、不进提示词（面板保留，随时点回来）
    if (state._muted) {
      list = list.filter(function (it) { return !state._muted[it.tag]; });
    }
    if (state._trainSolo) {
      list = list.map((it) => (it.src === 'character'
        ? Object.assign({}, it, { tag: String(it.tag).replace(/\(([^()]+):[\d.]+(?:,[\d.]+)*\)/g, '$1') })
        : it));
    }

    const prefix = model && model.prefix ? model.prefix.split(',').map((s) => s.trim()) : [];
    // 训练素材：强制单人单视角，否则模型会自作主张画「同一角色两个角度」。
    // 注意必须写进 prefix，正向最终用的是 prefix + list，写别的地方不会输出。
    if (state._trainSolo) {
      // 训练素材走精简路径：只用裸词、不加任何权重。
      // 提示词越长、权重词越多，近景越容易色彩溢出 —— 这批图本来就简单，不需要复杂描述。
      var _tmB = trainMode(state) || {};
      var _nude = !!_tmB.nude;
      var _solid = !!_tmB.solidBg;
      var _cd = state.pose && state.pose.sliders ? state.pose.sliders.camDist : null;
      var _expr0 = (state.feature && Array.isArray(state.feature.expression)) ? state.feature.expression : [];
      var _ec = _expr0.join(' ').indexOf('closed eyes') >= 0 || _expr0.join(' ').indexOf('half-closed') >= 0;
      var _angB = (state.scene && Array.isArray(state.scene.view)) ? state.scene.view : [];
      var _av = _angB.join(' ').toLowerCase();
      var _angBack = _av.indexOf('behind') >= 0;
      var _angSide = _av.indexOf('side') >= 0 || _av.indexOf('profile') >= 0;

      prefix.push('1girl', 'solo');
      if (_nude) prefix.push('nude');
      prefix.push('standing', 'upright, straight posture', 'arms at sides');
      // 朝向词必须跟着机位走：无条件写 facing viewer 会和 from behind 直接打架，
      // 实测选「背面」4 张里 3 张仍正脸朝镜头（负面压不住，因为是正向自相矛盾）。
      if (_angBack) prefix.push('back to viewer, facing away');
      else if (!_angSide) prefix.push('facing viewer');
      // 机位词加权并放进 prefix：原来它只是拼在正向尾部的裸词，模型基本忽略
      //（实测俯视 1/4、仰视 0/4 命中）。放进 prefix 后同名的裸词会被去重掉。
      var _ANG_W = { 'from above': 1.35, 'from below': 1.5, 'low angle': 1.4,
                     'from behind': 1.35, 'from side': 1.2, 'profile': 1.25,
                     'three-quarter view': 1.3, 'looking down at viewer': 1.2,
                     'dutch angle': 1.15 };
      if (_angSide) prefix.push('(standing straight:1.15)');
      _angB.forEach(function (v) {
        var k = normTag(v);
        if (!k || k === 'straight-on') return;
        if (prefix.indexOf(k) >= 0) return;
        if (_ANG_W[k] != null) prefix.push('(' + k + ':' + _ANG_W[k] + ')');
        else prefix.push(k);
      });
      // 正面角度没有方向 tag，模型会自己把头低下去/歪向侧面 —— 明确补一句正视镜头。
      // 选了「视线偏开」时不加，否则两句话打架。
      if (!_angB.length && _expr0.indexOf('looking away') < 0) prefix.push('looking at viewer, straight on');
      if (_solid) prefix.push('white background, simple background');
      if (!_ec) prefix.push('open eyes');
      // 半睁眼：裸词 half-closed eyes 被模型吃成正常睁眼（实测 1/5），
      // 必须加权 + 补 sleepy 才压得住；同时不能再写 open eyes（已由 _ec 判掉）。
      if (_expr0.join(' ').indexOf('half-closed') >= 0) {
        prefix.push('(half-closed eyes:1.35)', 'sleepy', '(eyelids half closed:1.2)');
      }
      if (_cd != null) {
        if (_cd >= 76) prefix.push('full body');
        else if (_cd >= 51) prefix.push('cowboy shot');
        else if (_cd >= 26) prefix.push('upper body');
        else prefix.push('close-up');
      }
    }

    // 软件内训练出来的角色 LoRA 自带触发词：挂上它就自动写进正向，
    // 用户不用记「这个词叫什么」，也不用另外找地方输入。
    if (state.loras && data.lora && Array.isArray(data.lora.items)) {
      data.lora.items.forEach((it) => {
        if (!it || !it.trigger) return;
        if (!(state.loras[it.file] > 0)) return;
        String(it.trigger).split(',').forEach((t) => {
          const s = t.trim();
          if (s && prefix.indexOf(s) < 0) prefix.push(s);
        });
      });
    }

    // 输出排序：人物 → 服装 → 姿势 → 场景 → 特征 → 画风；同模块内按优先级
    const SRC_ORDER = ['character', 'clothing', 'pose', 'scene', 'feature', 'style'];
    list.sort((a, b) => {
      const d = SRC_ORDER.indexOf(a.src) - SRC_ORDER.indexOf(b.src);
      return d !== 0 ? d : a.pri - b.pri;
    });
    // 模型前缀里已有的词不再重复输出（如 absurdres / score_9）
    const prefixKeys = new Set(prefix.map(normTag));
    list = list.filter((it) => !prefixKeys.has(normTag(it.tag)));

    const render = (arr) => arr.map((x) => x.tag).join(', ');
    const base = prefix.join(', ');
    let body = list.map((x) => x.tag);
    let text = [base, ...body].filter(Boolean).join(', ');
    let used = estTokens(text);

    const dropped = [];
    const rerender = () => { text = [base, ...list.map((x) => x.tag)].filter(Boolean).join(', '); used = estTokens(text); };
    let guard = 0;
    while (used > budget && guard++ < 200) {
      // 候选：pri>=3 优先砍，其次 pri=2；同优先级砍序号靠后的（画风 → 特征 → 场景）
      let victimIdx = -1, bestScore = -1;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (it.pri <= 1) continue;
        const score = it.pri * 1000 + i;
        if (score > bestScore) { bestScore = score; victimIdx = i; }
      }
      if (victimIdx < 0) break;
      dropped.push(list[victimIdx].tag);
      list.splice(victimIdx, 1);
      rerender();
    }
    // 硬兜底：优先级词砍完仍超预算时，从末尾（最不影响主构图）继续截断
    while (used > budget && list.length) {
      dropped.push(list[list.length - 1].tag);
      list.pop();
      rerender();
    }

    const negative = buildNegative(state, data);
    const param = computeParams(state, data);
    const warnings = [];
    // token 用量与互斥命中都不再打断用户，只在右上角 TOKEN 条上用颜色体现
    // 人种 vs 肤色：两个词方向相反时互相打架
    const rc = state.character && state.character.race;
    const sk = state.character && state.character.skinTone;
    if (rc && rc !== 'none' && sk != null) {
      if ((rc === 'african' || rc === 'south asian') && sk > 55) {
        warnings.push('人种选了「' + (rc === 'african' ? '非洲' : '南亚') + '」，但皮肤白皙度是 ' + sk + '（偏白）：两个词方向相反，建议把皮肤拉到 40 以下');
      } else if ((rc === 'nordic' || rc === 'caucasian' || rc === 'mediterranean') && sk < 35) {
        warnings.push('人种是「' + (rc === 'nordic' ? '北欧' : rc === 'caucasian' ? '欧洲' : '地中海') + '」，但皮肤白皙度只有 ' + sk + '（偏暗）：建议拉到 60 以上');
      }
    }
    // 穿衣逻辑一致性检查（互斥规则兜不住的情况，给提示而不是硬改）
    const cw = state.clothing || {};
    const hasTop = !!(cw.top && cw.top.length) && !rulesOut.cleared.has('clothing.top');
    const bottomArr = cw.bottom || [];
    const hasBottom = bottomArr.length > 0 && !bottomArr.includes('none') && !rulesOut.cleared.has('clothing.bottom');
    // 只有"其它部位穿了东西、但上下装都空"这种真矛盾才提示；全身一件没选属于有意为之，不打扰
    const anyGarment = !!((cw.underTop && cw.underTop.length) || (cw.underBottom && cw.underBottom.length)
      || (cw.legwear && cw.legwear.length) || (cw.shoes && cw.shoes.length) || (cw.accessory && cw.accessory.length));
    if (!hasTop && !hasBottom && anyGarment && cw.coverage != null && cw.coverage >= 20) {
      warnings.push('只穿了局部（内衣/袜/鞋/配饰）但上下装都空，覆盖度却是 ' + cw.coverage + '：这两个信号方向相反，建议把覆盖度拉到 20 以下');
    }
    if ((cw.wet != null && cw.wet > 60) && !hasTop && !hasBottom) {
      warnings.push('湿身值很高但没穿衣服：湿身词会失效');
    }
    if (!hasTop && !hasBottom && cw.damage != null && cw.damage > 40) {
      warnings.push('衣物破损值很高但没穿衣服：破损词会失效');
    }
    // 写实度：切模型时会自动对齐，这里不再弹冲突提示

    return {
      positive: text, negative, tokens: used, budget,
      dropped, warnings, param,
      sources: list.map((x) => ({ tag: x.tag, src: x.src, pri: x.pri })),
      rules: rulesOut
    };
  }

  // ---------- ComfyUI 工作流 ----------
  // 预处理器（依赖 custom_nodes/comfyui_controlnet_aux；已实测 DWPreprocessor 可用）
  const PREPROCESSORS = [
    { id: 'none', name: '原图直喂', desc: '你自己已经有骨架/深度/线稿图时用这个' },
    { id: 'openpose', name: 'DW 骨架', cls: 'DWPreprocessor', desc: '从照片自动提人物骨架（含手和脸），最准，对姿势还原度最高',
      args: { detect_hand: 'enable', detect_body: 'enable', detect_face: 'enable', resolution: 1024, bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt', scale_stick_for_xinsr_cn: 'disable' } },
    { id: 'depth', name: '深度图', cls: 'DepthAnythingV2Preprocessor', desc: '保空间与体积结构，不锁具体姿势，适合控制构图和景深（vits 小模型，8G 显存友好）',
      args: { ckpt_name: 'depth_anything_v2_vits.pth', resolution: 1024 } },
    { id: 'canny', name: 'Canny 边缘', cls: 'CannyEdgePreprocessor', desc: '提硬边线条，适合服装轮廓、建筑结构',
      args: { low_threshold: 100, high_threshold: 200, resolution: 1024 } },
    { id: 'lineart', name: '线稿', cls: 'LineArtPreprocessor', desc: '整齐线稿，会明显带风格化',
      args: { coarse: 'disable', resolution: 768 } }
  ];

  function buildWorkflow(p, loras, cn) {
    const wf = {
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.model } },
      "5": { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: p.positive || "", clip: ["4", 1] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: p.negative || "", clip: ["4", 1] } },
      "3": { class_type: "KSampler", inputs: { seed: p.seed || 0, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: p.prefix || "CPS", images: ["8", 0] } }
    };
    let modelRef = ["4", 0], clipRef = ["4", 1], n = 10;
    const active = Object.entries(loras || {}).filter(([, w]) => w > 0);
    for (const [file, w] of active) {
      const id = String(n++);
      wf[id] = { class_type: "LoraLoader", inputs: { model: modelRef, clip: clipRef, lora_name: file, strength_model: w, strength_clip: w } };
      modelRef = [id, 0]; clipRef = [id, 1];
      wf["3"].inputs.model = modelRef;
      wf["6"].inputs.clip = clipRef;
      wf["7"].inputs.clip = clipRef;
    }
    // ControlNet：需要一张已经提取好的控制图（骨架/深度/线稿）
    if (cn && cn.enabled && cn.image) {
      wf["20"] = { class_type: "ControlNetLoader", inputs: { control_net_name: cn.model || "controlnet-union-sdxl-promax.safetensors" } };
      wf["21"] = { class_type: "LoadImage", inputs: { image: cn.image } };
      // 预处理：开启后先由 aux 节点把照片转成骨架/深度/线稿，再喂给 ControlNet
      const pre = PREPROCESSORS.find((x) => x.id === (cn.pre || 'none'));
      let imgRef = ["21", 0];
      if (pre && pre.cls) {
        wf["23"] = { class_type: pre.cls, inputs: Object.assign({ image: ["21", 0] }, pre.args || {}) };
        imgRef = ["23", 0];
      }
      wf["22"] = {
        class_type: "ControlNetApplyAdvanced",
        inputs: {
          positive: ["6", 0], negative: ["7", 0],
          control_net: ["20", 0], image: imgRef,
          strength: (cn.strength != null ? cn.strength : 0.8),
          start_percent: (cn.start != null ? cn.start : 0),
          end_percent: (cn.end != null ? cn.end : 0.8)
        }
      };
      wf["3"].inputs.positive = ["22", 0];
      wf["3"].inputs.negative = ["22", 1];
    }
    return { prompt: wf };
  }

  // ---------- 默认状态 ----------
  function defaultState(data) {
    const st = { model: data.models.models[0].id, character: {}, clothing: {}, scene: {}, feature: {}, style: {},
      pose: { tier: 'light', id: 'L01', sliders: {}, subs: {}, view: 'third' },
      _covAuto: true,
      _off: {},
      // 默认不挂任何 LoRA：不同机器装的 LoRA 不一样，写死会导致「引用了不存在的文件」
      loras: {},
      negativeGroups: ['base', 'anatomy'], _lastTouched: 'character',
      controlnet: { enabled: false, image: '', pre: 'openpose', strength: 0.8, start: 0, end: 0.8, model: '' } };
    // 所有字段默认「不输出」：值一律为空，提示词里一个相关词都没有。
    // 用户想要什么，自己点一下启用；点「⟲」就回到这个空状态。
    const fill = (fields, target) => {
      for (const f of fields) {
        target[f.id] = f.type === 'multi' ? [] : null;
      }
    };
    fill(data.characters.fields, st.character);
    fill(data.clothing.fields, st.clothing);
    fill(data.scenes.fields, st.scene);
    fill(data.features.fields, st.feature);
    fill(data.styles.fields, st.style);
    // 滑条也全部留空（之前这里把 9 个滑条默认值写满了，导致每个体位都被染成同一种构图）
    return st;
  }

  function applyRecipe(state, recipe, available) {
    const s = clone(state);
    const p = recipe.patch || {};
    // 只切到本机存在的模型（配方里的 model 可能是别人的模型 id）
    if (recipe.model && (!available || !available.models || available.models.some((m) => m.id === recipe.model))) {
      s.model = recipe.model;
    }
    if (p.character) Object.assign(s.character, p.character);
    if (p.clothing) Object.assign(s.clothing, p.clothing);
    if (p.scene) Object.assign(s.scene, p.scene);
    if (p.features) Object.assign(s.feature, p.features);
    if (p.style) Object.assign(s.style, p.style);
    if (p.pose) { s.pose.tier = p.pose.tier; s.pose.id = p.pose.id; }
    if (p.lora) {
      // 过滤掉本机没装的 LoRA，避免「套用后一堆红字/出图报缺文件」
      const known = (available && available.loraFiles) || null;
      const out = {};
      Object.keys(p.lora || {}).forEach((f) => { if (!known || known.indexOf(f) >= 0) out[f] = p.lora[f]; });
      s.loras = out;
    }
    return s;
  }

  g.CPS = { build, buildWorkflow, defaultState, applyRecipe, estTokens, clone, lerpMap, PREPROCESSORS };
})(typeof window !== 'undefined' ? window : globalThis);
