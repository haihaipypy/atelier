/**
 * 给姿势库补齐英文动作描述（pose.en）。
 *
 * 为什么必须补：agnes-image-2.5-flash 的多图合成按「每张参考图扮演什么角色」理解，
 * 它不会自己从线稿里读出动作。条目没有文字动作时，提示词里只剩
 * 「reproduce the exact body posture…」这类类别名，模型就拿「服装展示照」的先验补空，
 * 结果正面站直、双臂下垂 —— 这是「姿势不生效」最直接的来源。
 *
 * 数据事实（2026-11-18 统计）：567 条里 440 条没有 pose.en，
 *   full_single_* 315 条 0%，upper80v2_* 125 条 0%（SP-* 那 127 条本来就有）。
 * 而「全身站立优先」排序把 full_single 整批推到第一屏，所以随手点第一个必然没描述。
 *
 * 做法：按中文标题（参考日文 rawTitle，它比中文更准确）逐条译成一句英文动作。
 * 表里没收录的标题不会被瞎猜：脚本会列出来并以非零码退出，防止悄悄漏掉。
 *
 * 用法：node scripts/fill-pose-en.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../web/public/data/pose.json', import.meta.url);

/**
 * 中文标题 → 英文动作。两句经验写进句式里：
 *   1) 先写身体姿态（站/坐/跪/躺），再手、脚，后头部与朝向；
 *   2) 抱头类明确写「肘部外张、手臂全长可见」——本地成功案例的作者原话是
 *      「强调肘部外张、手臂全长可见，能减少手臂缩成一团的问题」。
 */
const ACTIONS = {
  // ── 站立 ──
  '站立·单手後頭部': 'standing upright with one hand resting on the back of her head and the other arm relaxed at her side, facing the camera',
  '站立·单臂抬起腰挺出': 'standing with one arm raised up in the air and her hip pushed out to one side in a playful pose',
  '站立·双手腰': 'standing upright with both hands resting on her waist, elbows out to the sides',
  '站立·双手髪梳拢上': 'standing with both hands raised to her head, fingers running through her hair and lifting it up',
  '站立·双臂頭上伸直': 'standing with both arms stretched straight up high overhead in a full-body stretch, legs straight',
  '站立·后颈双手': 'standing upright with both hands raised behind her head resting on the nape of her neck, elbows spread wide outward so both arms are clearly visible shoulder to wrist',
  '站立·对立式站姿腰手': 'standing in a relaxed contrapposto stance with weight on one leg, both hands on her hips, shoulders slightly tilted',
  '站立·片足后抬起': 'standing on one leg with the other leg lifted and bent backward behind her, arms out for balance',
  '站立·肩越回头看': 'standing with her body turned away from the camera and looking back over her shoulder',
  '站立·脚尖站立双臂V字': 'standing up on tiptoe with both arms raised diagonally upward in a V shape, legs straight',
  '站立·脚開双手腰': 'standing with feet planted apart and both hands resting on her waist',
  '站立·腕后胸挺起': 'standing upright with both arms held behind her back and her chest pushed forward proudly',
  '站立·首元腿手': 'standing with one hand near her collarbone and the other hand touching her thigh',
  '站立·髪飘动': 'standing upright while her long hair is blown to one side as if by a gust of wind, one hand near her hair',
  // ── 后仰 / 扭转 ──
  '后仰·双臂抬起反': 'standing and leaning her upper body back with both arms raised overhead, chest arched, hips pushed forward',
  '后仰·站立姿勢反': 'standing with her upper body arched backward, chest lifted, both arms open behind her',
  '扭转·站立姿勢腕张开': 'standing with her upper body twisted to one side and both arms opened wide',
  '扭转·座上体扭转': 'sitting on the floor with her upper body twisted around to one side, one hand on the floor for support',
  '扭转·跪立回头看': 'kneeling upright on both knees with her upper body twisted, looking back over her shoulder',
  // ── 前倾 ──
  '前倾·单手腰·抬头看': 'bending her upper body forward with one hand on her hip, looking up toward the camera',
  '前倾·单脚后抬起': 'bending forward with one leg lifted and bent behind her, arms hanging down',
  '前倾·小腿轻触': 'bending forward with one hand lightly touching her own calf',
  '前倾·腕自然垂下放下': 'bending her upper body forward with both arms hanging down loosely and naturally',
  '前倾·腿手·腰引': 'bending forward with one hand on her thigh and her hips pulled back',
  '前倾·膝手': 'bending forward with both hands resting on her knees',
  // ── 蹲姿 ──
  '蹲姿·单手床': 'squatting low with one hand touching the floor for support, the other arm resting on her knee',
  '蹲姿·回头看': 'squatting low with her upper body turned to look back over her shoulder',
  '蹲姿·手抚头发': 'squatting low with one hand raised touching her hair, the other hand resting on her knee',
  '蹲姿·托腮': 'squatting low with one elbow resting on her knee and her chin propped on that hand',
  '蹲姿·脚尖站立双手床': 'squatting on tiptoe with both hands touching the floor in front of her',
  '蹲姿·膝手': 'squatting low with both hands resting on her knees',
  // ── 坐姿 ──
  '両肘支撑躺姿坐姿': 'sitting on the floor leaning back on both elbows with her legs stretched out in front of her',
  '仰反弓坐姿·单膝立起': 'sitting on the floor leaning her torso far back with one knee raised and bent, one hand supporting her behind',
  '单手支撑·脚前方斜放': 'sitting on the floor supported on one hand with both legs stretched out diagonally to the front side',
  '单膝立起·手抚头发': 'sitting on the floor with one knee raised and bent, the other leg extended, one hand raised touching her hair',
  '单膝立起·托腮': 'sitting on the floor with one knee raised and bent, her elbow on that knee and her cheek resting on the hand',
  '双手后支撑·胸挺起': 'sitting on the floor with both hands planted behind her for support, chest pushed forward, legs extended',
  '双手頭后·胸反弓': 'sitting on the floor with legs extended forward, both hands clasped behind her head with elbows spread wide, chest arched outward',
  '双腿浮后寄': 'sitting and leaning back with both legs lifted off the floor and folded to one side',
  '右傾·肘支撑': 'sitting on the floor tilting her body to her right, propped up on one elbow',
  '抱腿坐·膝左傾': 'sitting on the floor hugging both knees to her chest, knees tilted to her left',
  '膝立起双手頭后': 'sitting on the floor with one knee raised, both hands clasped behind her head, elbows spread wide outward so both arms are clearly visible',
  '脚斜伸展腰手': 'sitting on the floor with one leg stretched out diagonally and one hand resting on her waist',
  '足首手轻搭': 'sitting on the floor with one hand resting lightly on her own ankle',
  '足首持单膝立起': 'sitting on the floor with one knee raised, holding that leg by the ankle',
  // ── 鸭子坐 / 侧坐 ──
  '鸭子坐·前手支撑': 'sitting on the floor in a W-sit with legs folded to both sides, leaning forward with both hands on the floor in front',
  '鸭子坐·双手腿': 'sitting on the floor in a W-sit with legs folded to both sides, both hands resting on her thighs',
  '鸭子坐·双手頭后': 'sitting on the floor in a W-sit with legs folded to both sides, both hands clasped behind her head with elbows spread wide',
  '鸭子坐·后手支撑': 'sitting on the floor in a W-sit with legs folded to both sides, both hands planted on the floor behind her',
  '鸭子坐·首元手': 'sitting on the floor in a W-sit with legs folded to both sides, one hand touching her collarbone',
  '侧坐·单臂上伸直': 'sitting on the floor with both legs swept to one side, one arm stretched straight up overhead',
  '侧坐·右脚流': 'sitting on the floor with both legs swept together to her right side, hands resting in her lap',
  '侧坐·頬手': 'sitting on the floor with both legs swept to one side, one hand resting against her cheek',
  // ── 躺姿 ──
  '仰卧·单膝立起': 'lying flat on her back on the floor with one knee raised and bent, the other leg extended, arms relaxed beside her',
  '仰卧·双腿真上': 'lying flat on her back on the floor with both legs raised straight up toward the ceiling together, arms beside her body',
  '仰卧·双臂頭上': 'lying flat on her back on the floor with both arms extended above her head resting on the floor, legs straight',
  '仰卧·胸后仰': 'lying on her back on the floor with her chest arched upward and arms stretched behind her head',
  '侧卧寝·单臂頭上': 'lying on her side on the floor with one arm extended above her head resting on the floor, legs extended together',
  '侧卧寝·托腮': 'lying on her side on the floor with her head propped up on one hand, elbow on the floor, legs bent gently',
  '侧卧寝·腰': 'lying on her side on the floor with her hips curved and one hand resting on her waist, legs bent',
  '俯卧·手臂当枕': 'lying face down on her stomach on the floor, her head resting on her folded arms used as a pillow, legs extended',
  '俯卧·足抬起': 'lying face down on her stomach on the floor with her lower legs lifted and bent upward, chin up',
  // ── 跪立 ──
  '跪立·后手支撑反': 'kneeling upright on both knees leaning her torso back with both hands planted on the floor behind her, chest arched',
  // ── 上半身·可爱系 ──
  '下巴下双剪刀手': 'facing the camera with both hands raised under her chin making two peace signs',
  '兔耳姿势': 'facing the camera with both hands raised above her head making bunny-ear gestures with her index fingers',
  '兽爪姿势': 'facing the camera with both hands raised beside her face like playful animal claws, fingers curled',
  '单手心形＋单手胸': 'facing the camera making a single-hand heart gesture with that hand raised in front of her chest',
  '双手下巴放置（花朵手势）': 'facing the camera with both open palms under her chin framing her face like a flower',
  '双手指隙間': 'facing the camera with both hands open in front of her face, peeking through the gaps between her fingers',
  '双手脸颊捧住': 'facing the camera with both hands cupping her own cheeks',
  '嘘声手势（食指唇）': 'facing the camera with one index finger pressed to her lips in a shush gesture',
  '打哈欠伸（单手嘴边）': 'facing the camera with one hand raised to her mouth as if yawning and stretching',
  '投飞吻': 'facing the camera blowing a kiss with one hand lifted beside her lips',
  '招猫猫手': 'facing the camera with one hand raised beside her face in a beckoning cat-paw gesture',
  '指框景': 'facing the camera framing her own face with both hands, thumbs and index fingers forming a rectangle',
  '握拳手脸颊（装可爱子）': 'facing the camera with one clenched fist pressed against her cheek in a cute pose',
  '敬礼姿势': 'facing the camera giving a playful salute with one hand at her forehead',
  '胸前双手心形': 'facing the camera making a two-hand heart shape in front of her chest',
  '萌袖風双手嘴边遮住': 'facing the camera hiding her mouth behind both hands with her sleeves pulled over them',
  '自分抱收紧照姿势': 'facing the camera hugging herself with both arms crossed over her chest in a shy pose',
  '辣妹剪刀手（手甲剪刀手）': 'facing the camera making a peace sign with the back of her hand turned toward the viewer, arm raised beside her face',
  '镜头指差': 'facing the camera pointing directly at the viewer with one index finger',
  '頬横比心': 'facing the camera making a small finger heart beside her cheek with one hand',
  '頭上双臂心形': 'facing the camera with both arms raised above her head forming a heart shape',
  '願姿势（双手合合拢）': 'facing the camera with both palms pressed together in front of her chest in a pleading gesture',
  '食指脸颊傲娇': 'facing the camera poking her own cheek with one index finger in a pouting pose',
  '首歪＋片目手（眨眼風）': 'facing the camera with her head tilted to one side and one hand raised beside one eye in a winking gesture',
  '髪耳动作': 'facing the camera tucking her hair behind one ear with one hand',
};

const dry = process.argv.includes('--dry');
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const items = data.items || [];

let filled = 0;
const missing = new Set();

for (const it of items) {
  it.pose = it.pose || {};
  // 已有描述（SP-* 那 127 条）一律不动，避免覆盖人工校对过的文本
  if (String(it.pose.en || '').trim()) continue;
  const en = ACTIONS[it.title || ''];
  if (!en) {
    missing.add(it.title || '(无标题)');
    continue;
  }
  it.pose.en = en;
  filled += 1;
}

const blank = items.filter((i) => !String(i.pose?.en || '').trim()).length;
console.log(`补齐 ${filled} 条，仍为空 ${blank} 条，共 ${items.length} 条`);
if (missing.size) {
  console.error(`\n以下 ${missing.size} 个标题没有对应译文（未写入，需补表）：`);
  for (const t of missing) console.error('  ' + t);
  process.exitCode = 1;
}

if (dry) {
  console.log('\n--dry：未写文件');
} else if (filled) {
  writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\n已写入 ${FILE.pathname}`);
}
