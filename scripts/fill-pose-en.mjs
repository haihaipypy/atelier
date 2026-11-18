/**
 * 给姿势库补齐英文动作描述（pose.en）。
 *
 * 为什么必须补：agnes-image-2.5-flash 的多图合成按「每张参考图扮演什么角色」理解，
 * 它不会自己从线稿里读出动作。条目没有文字动作时，提示词里只剩
 * 「reproduce the exact body posture…」这类类别名，模型就拿「服装展示照」的先验补空，
 * 结果正面站直、双臂下垂 —— 这是「姿势不生效」最直接的来源。
 *
 * ⚠️ 第一版踩过的坑（2026-11-18 晚）：按标题逐条译时，为了让句子读起来完整，
 * 我给每一条都补了「另一只手 / 腿部站姿 / 朝向」——而标题只描述一个显著特征，
 * 补出来的部分全是猜的。P020「立ち・片手を後頭部に」被我写成
 *   "…and the other arm relaxed at her side"
 * 线稿上另一只手明明是叉腰、双脚分开重心偏一侧，成品照着文字画成了
 * 「一手扶头 + 一手垂在身侧 + 双腿并拢」。**模型信文字胜过信线稿**，
 * 所以一句猜错的补充，比不写更能毁掉姿势。
 *
 * 因此第二版的唯一准则：**只写标题能确认的事**。
 *   · 标题只写了一只手 → 就只写这只手，另一只手一个字不提；
 *   · 标题只写了上半身动作 → 不提腿怎么站、脚朝哪；
 *   · 只有标题点了「頭の後ろ / うなじ」这类必然导致肘部外张的动作，才写 elbow out（物理必然）；
 *   · 一律不写「facing the camera」这类朝向断言——朝向由线稿决定。
 * 剩下的部分全部由 buildPrompt 的 POSE 段点名「到图 1 里去看」。
 *
 * 数据事实（2026-11-18 统计）：567 条里 440 条原本没有 pose.en，
 *   full_single_* 315 条 0%，upper80v2_* 125 条 0%（SP-* 那 127 条上游自带）。
 * 而「全身站立优先」排序把 full_single 整批推到第一屏，所以随手点第一个必然没描述。
 *
 * 归属规则：SP-* 是上游自带的人工描述，永不覆盖；full_single_* / upper80v2_* 是本脚本
 * 生成的，每次重跑都按当前表重写（内容相同 → 结果不变，仍是幂等）。
 *
 * ⚠️ 2026-11-18 晚起，正式描述已改成「逐个看图写」，见 scripts/pose-descs.mjs +
 * scripts/apply-pose-descs.mjs。本脚本退化为「新增条目时的初版草稿」：
 * 它按标题译，标题没写的部位它也不会写，所以只能当草稿，不能当成品。
 * 两个脚本都跑过一次的话，以 apply-pose-descs.mjs 为准。
 *
 * 用法：node scripts/fill-pose-en.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../web/public/data/pose.json', import.meta.url);

/**
 * 中文标题 → 英文动作（只译标题，不扩写）。
 * 句式：身体基准（站/坐/跪/躺）→ 手 → 必要的肘部外张。
 */
const ACTIONS = {
  // ── 站立 ──
  // 这条是逐个看图写的（full_single_P020 的 5 个机位 + shisei 的 std_P020_front/_diag 都是同一姿势）：
  // 一只手扶后脑、另一只手叉腰、双脚分开重心偏一侧。标题只写了前半句，补后半句是因为看过图。
  '站立·单手後頭部': 'standing with one hand raised to the back of her head and the other hand on her hip, elbows out wide, feet apart with the weight on one leg',
  '站立·单臂抬起腰挺出': 'standing with one arm raised up in the air and her hip pushed out to one side',
  '站立·双手腰': 'standing with both hands on her waist, elbows out to the sides',
  '站立·双手髪梳拢上': 'standing with both hands lifted to her head, fingers combing her hair up',
  '站立·双臂頭上伸直': 'standing with both arms stretched straight up overhead',
  '站立·后颈双手': 'standing with both hands raised behind her neck, elbows spread wide out to the sides so both arms stay visible shoulder to wrist',
  '站立·对立式站姿腰手': 'standing in a contrapposto stance with her weight on one leg, both hands on her hips',
  '站立·片足后抬起': 'standing on one leg with the other leg lifted and bent behind her',
  '站立·肩越回头看': 'standing with her body turned away and looking back over her shoulder',
  '站立·脚尖站立双臂V字': 'standing up on her toes with both arms raised diagonally overhead in a V shape',
  '站立·脚開双手腰': 'standing with her feet planted wide apart and both hands on her waist',
  '站立·腕后胸挺起': 'standing with both arms held behind her back and her chest lifted',
  '站立·首元腿手': 'standing with one hand at the base of her neck and the other hand on her thigh',
  '站立·髪飘动': 'standing with her hair blown to one side as if by wind, one hand near her hair',
  // ── 后仰 / 扭转 ──
  '后仰·双臂抬起反': 'standing and arching her upper body backward with both arms raised overhead',
  '后仰·站立姿勢反': 'standing with her upper body arched backward, her chest lifted and her shoulders drawn back',
  '扭转·站立姿勢腕张开': 'standing with her upper body twisted to one side and both arms opened wide',
  '扭转·座上体扭转': 'sitting on the floor with her upper body twisted to one side and her shoulders turned the same way',
  '扭转·跪立回头看': 'kneeling upright with her upper body twisted, looking back over her shoulder',
  // ── 前倾 ──
  '前倾·单手腰·抬头看': 'bending her upper body forward with one hand on her hip, looking up',
  '前倾·单脚后抬起': 'bending forward with one leg lifted and bent behind her',
  '前倾·小腿轻触': 'bending forward with one hand touching her own shin',
  '前倾·腕自然垂下放下': 'bending her upper body forward with both arms hanging down loosely',
  '前倾·腿手·腰引': 'bending forward with one hand on her thigh and her hips pulled back',
  '前倾·膝手': 'bending forward with both hands resting on her knees',
  // ── 蹲姿 ──
  '蹲姿·单手床': 'squatting down low with one hand touching the floor',
  '蹲姿·回头看': 'squatting down low and looking back over her shoulder',
  '蹲姿·手抚头发': 'squatting down low with one hand touching her hair',
  '蹲姿·托腮': 'squatting down low with one hand propping up her chin',
  '蹲姿·脚尖站立双手床': 'squatting on her toes with both hands touching the floor in front of her',
  '蹲姿·膝手': 'squatting down low with both hands resting on her knees',
  // ── 坐姿 ──
  '両肘支撑躺姿坐姿': 'sitting on the floor leaning back on both elbows with her legs stretched out in front',
  '仰反弓坐姿·单膝立起': 'sitting on the floor leaning her torso far back with one knee raised and bent',
  '单手支撑·脚前方斜放': 'sitting on the floor propped up on one hand with both legs stretched out diagonally in front',
  '单膝立起·手抚头发': 'sitting on the floor with one knee raised and bent, one hand touching her hair',
  '单膝立起·托腮': 'sitting on the floor with one knee raised and bent, one hand propping up her chin',
  '双手后支撑·胸挺起': 'sitting on the floor with both hands planted behind her and her chest pushed forward',
  '双手頭后·胸反弓': 'sitting on the floor with both hands clasped behind her head, elbows spread wide out to the sides, chest arched',
  '双腿浮后寄': 'sitting and leaning back with both legs lifted off the floor',
  '右傾·肘支撑': 'sitting on the floor tilted over to her right, propped up on one elbow',
  '抱腿坐·膝左傾': 'sitting on the floor hugging both knees to her chest, her knees tilted to her left',
  '膝立起双手頭后': 'sitting on the floor with one knee raised, both hands clasped behind her head, elbows spread wide out to the sides',
  '脚斜伸展腰手': 'sitting on the floor with one leg stretched out diagonally and one hand on her waist',
  '足首手轻搭': 'sitting on the floor with one hand resting lightly on her own ankle',
  '足首持单膝立起': 'sitting on the floor with one knee raised, holding that leg by the ankle',
  // ── 鸭子坐 / 侧坐 ──
  '鸭子坐·前手支撑': 'sitting on the floor in a W-sit with her legs folded to both sides, leaning forward with both hands on the floor in front',
  '鸭子坐·双手腿': 'sitting on the floor in a W-sit with her legs folded to both sides, both hands on her thighs',
  '鸭子坐·双手頭后': 'sitting on the floor in a W-sit with her legs folded to both sides, both hands clasped behind her head, elbows spread wide out to the sides',
  '鸭子坐·后手支撑': 'sitting on the floor in a W-sit with her legs folded to both sides, both hands planted on the floor behind her',
  '鸭子坐·首元手': 'sitting on the floor in a W-sit with her legs folded to both sides, one hand at the base of her neck',
  '侧坐·单臂上伸直': 'sitting on the floor with both legs swept to one side, one arm stretched straight up overhead',
  '侧坐·右脚流': 'sitting on the floor with both legs swept together to her right side',
  '侧坐·頬手': 'sitting on the floor with both legs swept to one side, one hand resting against her cheek',
  // ── 躺姿 ──
  '仰卧·单膝立起': 'lying on her back on the floor with one knee raised and bent, the other leg extended',
  '仰卧·双腿真上': 'lying on her back on the floor with both legs raised straight up toward the ceiling',
  '仰卧·双臂頭上': 'lying on her back on the floor with both arms stretched above her head resting on the floor',
  '仰卧·胸后仰': 'lying on her back on the floor with her chest arched up and her hips lifted off the floor',
  '侧卧寝·单臂頭上': 'lying on her side on the floor with one arm stretched above her head',
  '侧卧寝·托腮': 'lying on her side on the floor with her head propped up on one hand',
  '侧卧寝·腰': 'lying on her side on the floor with the curve of her hips showing, one hand resting on her waist',
  '俯卧·手臂当枕': 'lying face down on the floor with her head resting on her folded arms',
  '俯卧·足抬起': 'lying face down on the floor with her lower legs lifted and bent up',
  // ── 跪立 ──
  '跪立·后手支撑反': 'kneeling upright on both knees, leaning her torso back with both hands planted on the floor behind her',
  // ── 上半身·可爱系（手势类，只写手势，姿态与朝向交给线稿）──
  '下巴下双剪刀手': 'both hands raised under her chin making two peace signs',
  '兔耳姿势': 'both hands raised above her head making bunny ears with her index fingers',
  '兽爪姿势': 'both hands raised beside her face like playful animal claws, fingers curled',
  '单手心形＋单手胸': 'one hand raised making a small heart shape, the other hand on her chest',
  '双手下巴放置（花朵手势）': 'both open palms under her chin framing her face like a flower',
  '双手指隙間': 'both hands open in front of her face, peeking through the gaps between her fingers',
  '双手脸颊捧住': 'both hands cupping her cheeks',
  '嘘声手势（食指唇）': 'one index finger pressed to her lips in a shush gesture',
  '打哈欠伸（单手嘴边）': 'one hand raised to her mouth as if yawning and stretching',
  '投飞吻': 'one hand lifted beside her lips blowing a kiss',
  '招猫猫手': 'one hand raised beside her face in a beckoning cat-paw gesture',
  '指框景': 'both hands framing her face, thumbs and index fingers forming a rectangle',
  '握拳手脸颊（装可爱子）': 'one clenched fist pressed against her cheek',
  '敬礼姿势': 'one hand at her forehead in a playful salute',
  '胸前双手心形': 'both hands forming a heart shape in front of her chest',
  '萌袖風双手嘴边遮住': 'both hands hiding her mouth, her sleeves pulled over her hands',
  '自分抱收紧照姿势': 'both arms crossed hugging herself over her chest',
  '辣妹剪刀手（手甲剪刀手）': 'one peace sign raised beside her face with the back of her hand turned outward',
  '镜头指差': 'one index finger pointing straight at the camera',
  '頬横比心': 'one hand making a small finger heart beside her cheek',
  '頭上双臂心形': 'both arms raised above her head forming a heart shape',
  '願姿势（双手合合拢）': 'both palms pressed together in front of her chest in a pleading gesture',
  '食指脸颊傲娇': 'one index finger poking her own cheek',
  '首歪＋片目手（眨眼風）': 'her head tilted to one side, one hand raised beside one eye in a winking gesture',
  '髪耳动作': 'one hand tucking her hair behind her ear',
};

/** SP-* 是上游的人工描述（经过校对），默认不覆盖 */
const isUpstream = (id) => /^SP-/.test(String(id || ''));

/**
 * 逐个看线稿核对过、确认上游文案与线稿不符的条目。
 *
 * SP-P020：上游写「the other arm relaxed at her side」，但 std_P020_front / _diag 两张线稿
 * 清清楚楚是「另一只手叉腰（肘外张）+ 双脚分开、一只脚尖点地、重心偏一侧」。
 * 这条文案和第一版手写表犯的是同一个错——按标题补了一句没看图的话。
 * 它比手写表更危险：SP-P020 是「站立」分类里最常见的姿势之一，用户很可能正好点它。
 */
const OVERRIDES = {
  'SP-P020-diag': 'standing with one hand raised to the back of her head and the other hand on her hip, elbows out wide, feet apart with the weight on one leg',
  'SP-P020-front': 'standing with one hand raised to the back of her head and the other hand on her hip, elbows out wide, feet apart with the weight on one leg',
};

const dry = process.argv.includes('--dry');
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const items = data.items || [];

let filled = 0;
let rewritten = 0;
const missing = new Set();

for (const it of items) {
  it.pose = it.pose || {};
  // 校正表优先：这些条目是「看过线稿、确认上游文案与图不符」的，例外必须生效
  const fixed = OVERRIDES[it.id];
  if (fixed) {
    if (it.pose.en !== fixed) {
      if (String(it.pose.en || '').trim()) rewritten += 1;
      it.pose.en = fixed;
      it.pose.src = 'lineart-check';
      filled += 1;
    }
    continue;
  }
  if (isUpstream(it.id)) continue;
  const en = ACTIONS[it.title || ''];
  if (!en) {
    // 只有「本来没描述」的条目才算漏译；上游条目已在上一步跳过
    if (!String(it.pose.en || '').trim()) missing.add(it.title || '(无标题)');
    continue;
  }
  if (String(it.pose.en || '').trim() === en) continue;
  if (String(it.pose.en || '').trim()) rewritten += 1;
  it.pose.en = en;
  it.pose.src = 'title-v2';
  filled += 1;
}

const blank = items.filter((i) => !String(i.pose?.en || '').trim()).length;
console.log(`写入 ${filled} 条（其中修正 ${rewritten} 条），仍为空 ${blank} 条，共 ${items.length} 条`);
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
