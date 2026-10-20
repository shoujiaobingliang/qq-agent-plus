// 插件安装器：从官方索引或一个 URL 把插件装进 `$DATA_DIR/plugins/<id>/`。
//
// 装的是**别人写的代码**，所以这一层每一步都要能挡人：
//   · URL 只走 safe-fetch（内网/ SSRF / 体积 / 超时都在里面），不做裸 fetch；
//   · **必须给 sha256**（索引里带、或用户手填）：不给就拒绝装 —— "从网上抓一段代码跑起来"
//     这件事至少要让安装者对内容有个可核对的锚点；
//   · 解包自己解析 tar（不 shell 出去调 tar）：能逐条拒绝目录穿越、绝对路径、符号链接、
//     硬链接与设备节点 —— 交给外部 tar 就管不住这些；
//   · 先解到 staging 目录、校验 manifest（与宿主同一份校验）、再原子换入；换入前把旧版本挪到
//     备份目录，失败原样放回（"装坏了但旧版也没了"是最难受的失败模式）。
import crypto from 'node:crypto';
import { versionRule } from './version.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PLUGIN_API_VERSION, parsePluginManifest } from './manifest.js';

export const MAX_PLUGIN_ARCHIVE_BYTES = 5 * 1024 * 1024;   // 插件是"几个 JS 文件"，5MB 足够
export const MAX_TOTAL_UNPACKED = 20 * 1024 * 1024;   // 导出给用例用（解压后的上限口径）

const fail = (code, message) => Object.assign(new Error(message), { code });

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** sha256 十六进制串的形状校验（大小写都收，比较时统一小写）。 */
export function isSha256(value) {
  return /^[0-9a-f]{64}$/i.test(String(value ?? '').trim());
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function verifySha256(buffer, expected) {
  const want = String(expected ?? '').trim().toLowerCase();
  if (!isSha256(want)) throw fail('E_SHA_SHAPE', 'sha256 必须是 64 位十六进制');
  const got = sha256Of(buffer);
  if (got !== want) throw fail('E_SHA_MISMATCH', `内容校验失败：期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
  return true;
}

const TAR_BLOCK = 512;

/** tar 头校验和：把 checksum 字段当空格求和，与头里写的八进制值比对。 */
function verifyTarChecksum(header) {
  const declared = readOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (declared !== sum) throw fail('E_ARCHIVE', '归档头校验和不匹配（文件损坏，或根本不是 tar）');
}

/** 解一段八进制字段（tar 里都是 "\0" 结尾的八进制串）。 */
function readOctal(buffer) {
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解析 tar（.tar 或 .tar.gz）成 `{ name, type, data }` 列表。
 * **逐条拒绝**：绝对路径、`..`（目录穿越）、符号链接/硬链接/设备节点（只有普通文件与目录放行）。
 * 不认识的结构直接报错 —— 宁可装不上，也不要"以为自己装的是 A、其实解出来一堆别的东西"。
 */
export function parseTarGz(buffer) {
  let raw = buffer;
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      // **必须设上限**：gzip 压缩比可达 1000:1，一个 5MB 的包能让解压试图展开到 GB 级 ——
      // 这段代码跑在宿主进程里（不是插件的沙箱子进程），一次 OOM 带走的是整个机器人。
      // 上限按"解包后"的口径留出 tar 头与对齐的余量。
      raw = zlib.gunzipSync(buffer, { maxOutputLength: MAX_TOTAL_UNPACKED + 4 * 1024 * 1024 });
    } catch (error) {
      if (String(error?.code || '') === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength/i.test(String(error?.message || ''))) {
        throw fail('E_ARCHIVE', `解压后超过上限 ${Math.round(MAX_TOTAL_UNPACKED / 1024 / 1024)}MB，已拒绝（疑似压缩炸弹）`);
      }
      throw fail('E_ARCHIVE', `不是合法的 gzip：${error?.message ?? error}`);
    }
  }
  const entries = [];
  let offset = 0;
  let total = 0;
  while (offset + TAR_BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + TAR_BLOCK);
    // 全零块 = 归档结束（正常有两个）
    if (header.every((byte) => byte === 0)) break;
    // 校验和：tar 头自带的完整性判据。不验的话，坏掉的归档会被"按字段解出另一份内容"，
    // 而 sha256 校的是整个包 —— 两者本该一致，坏就坏在解析层（2026-10-15 复审 P3-8）
    verifyTarChecksum(header);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = readOctal(header.subarray(124, 136));
    const typeByte = header[156];
    const type = String.fromCharCode(typeByte || 0x30);
    // 名字归一化：`tar -czf x .` 打出来的条目叫 `./x`，`tar -czf x dir/` 会带尾斜杠 ——
    // 不归一化的话后面按名字找 plugin.json 就会找不到（而且 `./` 这种根条目要当不存在）。
    const full = (prefix ? `${prefix}/${name}` : name)
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    offset += TAR_BLOCK;
    const dataEnd = offset + size;
    if (dataEnd > raw.length) throw fail('E_ARCHIVE', '归档被截断（头的长度与实际内容不一致）');
    if (!full || full === '.') {
      // 归档根（`./`）没有内容要写，跳过；但数据块还是要按长度跳过去
      offset = dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
      continue;
    }

    if (!['0', '\0', '5'].includes(type)) {
      // 'x'/'L' 是 pax 扩展头与 GNU 长路径头：真支持它们得先解析扩展属性，否则会解出错的路径。
      // v1 直接拒绝并给出可操作的指引，比"悄悄解错"强。
      const hint = (type === 'x' || type === 'L' || type === 'g')
        ? '（归档用了 pax/长路径扩展头：请用 `tar --format=ustar -czf` 重打，或把文件名缩短）'
        : '（符号链接/硬链接/设备节点都不允许）';
      throw fail('E_ARCHIVE', `归档里有不允许的条目类型 ${type}${hint}`);
    }
    if (!full || full.startsWith('/') || /^[A-Za-z]:/.test(full) || full.split('/').some((seg) => seg === '..')) {
      throw fail('E_ARCHIVE', `归档里有不安全的路径：${full || '(空)'}`);
    }
    total += size;
    if (total > MAX_TOTAL_UNPACKED) throw fail('E_ARCHIVE', '解包后体积超过上限，已拒绝安装');
    if (type !== '5') entries.push({ name: full, type: 'file', data: raw.subarray(offset, dataEnd) });
    else entries.push({ name: full.replace(/\/$/, ''), type: 'dir', data: null });
    offset = dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
  }
  if (!entries.length) throw fail('E_ARCHIVE', '归档里没有任何文件');
  return entries;
}

/** 把条目写进目标目录（只在解析器已经校验过路径的前提下调用）。 */
export function extractEntries(entries, targetDir) {
  for (const entry of entries) {
    const full = path.join(targetDir, entry.name);
    if (full !== targetDir && !full.startsWith(targetDir + path.sep)) {
      throw fail('E_ARCHIVE', `拒绝写出目录外：${entry.name}`);
    }
    if (entry.type === 'dir') { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.data);
  }
}

/**
 * 常见的打包形状是"外层套一个目录"（`tar -czf x.tar.gz myplugin/`）：
 * 里面只有一层目录、且根下没有 plugin.json 时，把这一层剥掉再按根处理。
 */
function unwrapSingleRoot(entries) {
  if (entries.some((entry) => entry.name === 'plugin.json')) return entries;
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]));
  if (tops.size !== 1) return entries;
  const [top] = [...tops];
  if (!top || entries.some((entry) => entry.name === top && entry.type === 'file')) return entries;
  return entries
    .filter((entry) => entry.name !== top)
    .map((entry) => ({ ...entry, name: entry.name.slice(top.length + 1) }))
    .filter((entry) => entry.name);
}

/**
 * 从索引项或手填信息安装一个插件。
 * @param fetchBinary  注入点（默认 safe-fetch 的二进制下载，测试可注入）
 * @returns {ok, id, version, upgraded, backupDir?} 或抛带 code 的错误
 */
export async function installPlugin({
  id = '', url = '', sha256 = '', tarball = null, dataDir,
  fetchBinary, log = () => {}, now = () => Date.now(), source = '', hostVersion = '',
  publisher = '', signature = '', publishers = {}, beforeReplace = null
} = {}) {
  // 注入点先落到本地常量：scan --strict（CI 门禁）不认"直接调用解构参数的默认值"这种形状
  const download = fetchBinary;
  const pluginsRoot = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  // id 会进 staging 的目录名：**必须先校验**，否则 '../../x' 之类的 id 会把解包写到插件目录之外
  //（2026-10-15 复审 P2；最终换入那一步本来就有校验，这里只是把它提前到"写盘之前"）
  const requestedId = String(id ?? '').trim();
  if (requestedId && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(requestedId)) {
    // 独立错误码：与下面那条"包里的 id 与预期不符"区分开 —— 这一条发生在**任何写盘之前**，
    // 混用同一个 code/文案的话，用例咬不出"校验被挪到写盘之后"这种改动（2026-10-15 复审）
    throw fail('E_BAD_ID', '插件 id 不合法（只允许小写字母/数字/连字符，2-32 位）');
  }

  let buffer = tarball;
  if (!buffer) {
    const target = String(url ?? '').trim();
    if (!target) throw fail('E_ARGS', '缺少下载地址');
    if (!isSha256(sha256)) {
      throw fail('E_SHA_REQUIRED', '必须提供 sha256（安装第三方代码前，至少要有一个可核对的内容锚点）');
    }
    if (typeof fetchBinary !== 'function') throw fail('E_NO_FETCH', '没有可用的下载实现');
    const downloaded = await download(target, MAX_PLUGIN_ARCHIVE_BYTES);
    buffer = downloaded?.buffer;
    if (!buffer?.length) throw fail('E_DOWNLOAD', '下载内容为空');
    if (buffer.length > MAX_PLUGIN_ARCHIVE_BYTES) throw fail('E_DOWNLOAD', `超过体积上限 ${MAX_PLUGIN_ARCHIVE_BYTES / 1024 / 1024}MB`);
  }
  if (!buffer?.length) throw fail('E_ARGS', '没有可安装的内容');
  // 给了 sha256 就得是个能核对的东西：形状不对就报错，而不是"跳过校验继续装"（与 verifySha256 同口径）
  const declaredSha = String(sha256 ?? '').trim();
  if (declaredSha && !isSha256(declaredSha)) throw fail('E_SHA_SHAPE', 'sha256 必须是 64 位十六进制');
  if (isSha256(declaredSha)) verifySha256(buffer, declaredSha);

  // 发布者签名：登记过公钥的发布者，**必须**带签名且验得通过才允许安装。
  // 没登记公钥的照常装（生态起步阶段不能把路堵死），但记录里如实标"未验证"，
  // 控制台也会显示 —— 用户至少知道这一条没有密码学证据。
  const publisherName = String(publisher ?? '').trim();
  const declaredKey = publisherName ? String(publishers?.[publisherName] ?? '').trim() : '';
  let signatureVerified = false;
  if (publisherName && declaredKey) {
    const checked = verifyPluginSignature({ buffer, signature, publicKey: declaredKey });
    if (!checked.ok) {
      throw fail('E_SIGNATURE', `发布者「${publisherName}」已登记公钥，但这个包没通过验签：${checked.error}`);
    }
    signatureVerified = true;
  } else if (String(signature ?? '').trim()) {
    log(`[plugins] 包带了签名，但没有登记发布者「${publisherName || '(未署名)'}」的公钥，跳过验签（记录里标为未验证）`);
  }

  const entries = unwrapSingleRoot(parseTarGz(buffer));
  // staging 目录名交给 mkdtempSync 保证唯一。原来自己拼 `.staging-<id>-<pid>-<now()>`：
  // 同一毫秒 + 同一 id 的两次并发安装会算出同一个名字（`recursive:true` 也不报 EEXIST），
  // 两边的文件互相覆盖 —— 最坏是把两棵树混在一起换入正式目录。
  const staging = fs.mkdtempSync(path.join(pluginsRoot, `.staging-${requestedId || 'plugin'}-`));
  try {
    extractEntries(entries, staging);
    // manifest 必须合法、且 id 与目录名一致（与宿主同一份校验：两处口径分裂会出人命）。
    // 先按**精确大小写**确认文件存在：Windows 上 `Plugin.json` 也能读到，装完到 Linux 就散架。
    if (!fs.readdirSync(staging).includes('plugin.json')) {
      throw fail('E_MANIFEST', '包里没有 plugin.json（文件名大小写必须完全一致）');
    }
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(staging, 'plugin.json'), 'utf8')); }
    catch { throw fail('E_MANIFEST', '包里没有 plugin.json（或不是合法 JSON）'); }
    const parsed = parsePluginManifest(raw, { dir: staging });
    if (!parsed.ok) throw fail('E_MANIFEST', parsed.error);
    if (id && parsed.manifest.id !== id) throw fail('E_ID_MISMATCH', `包里的 id（${parsed.manifest.id}）与预期（${id}）不一致`);
    const finalId = parsed.manifest.id;
    const target = path.join(pluginsRoot, finalId);
    if (path.dirname(target) !== pluginsRoot) throw fail('E_ARGS', '插件 id 不合法');

    let backupDir = '';
    const upgrading = fs.existsSync(target);
    if (upgrading) {
      // 目录名必须**唯一**：同一毫秒内连做两次升级时（脚本里连装、或很快的机器），
      // 只用时间戳会撞名，而 rename 到"非空目录"会 ENOTEMPTY 直接失败
      //（2026-10-15 服务器实测抓到：同一台机器上 4 次连装必现）。
      for (let n = 0; n < 100 && !backupDir; n += 1) {
        const candidate = path.join(pluginsRoot, `.backup-${finalId}.${now()}-${n}`);
        if (!fs.existsSync(candidate)) backupDir = candidate;
      }
      if (!backupDir) throw fail('E_SWAP', '备份目录名一直冲突（连续升级太密集），已中止以免覆盖旧版本');
      // 换入前先让调用方停掉正在跑的插件进程：子进程 cwd 就是插件目录，Windows 上 rename 一个
      // 存活进程的 cwd 会 EPERM/EBUSY（Linux 能过，所以跨平台 CI 抓不到这条路）。
      // 放在"备份名已经占好、真正 rename 之前"：下载/解包/验签失败时不必白白停掉插件。
      // 注入点先落到本地常量：scan --strict 不认"直接调用解构参数"的形状
      const replace = beforeReplace;
      if (typeof replace === 'function') {
        try { await replace(finalId); }
        catch (error) { log(`[plugins] 换入前停进程失败（继续尝试换入）：${error?.message ?? error}`); }
      }
      fs.renameSync(target, backupDir);   // 同一文件系统内 rename：换入是原子的
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      // 回滚自己也可能失败（权限、被占用）。这时既不能把主错误顶掉，也不能谎报"已回滚"：
      // 两边都写清楚，让人知道磁盘上现在到底是什么状态。
      let rollback = '已回滚（旧版原样放回）';
      if (upgrading && backupDir && !fs.existsSync(target)) {
        try { fs.renameSync(backupDir, target); }
        catch (rollbackError) {
          rollback = `**回滚也失败了**：${rollbackError?.message ?? rollbackError}`
            + `（旧版仍在 ${path.basename(backupDir)} 里，需要人工放回）`;
        }
      }
      throw fail('E_SWAP', `换入失败：${error?.message ?? error}；${rollback}`);
    }
    pruneBackups(pluginsRoot, finalId, now);
    // 来源记录：这段代码是从哪来的、装的哪一份、什么时候装的。写入失败**不能让安装失败**
    //（代码已经换进去了，回滚才是更坏的结果），但要在日志里留痕。
    const record = writePluginInstallInfo({
      dataDir, id: finalId, source, url, sha256: isSha256(sha256) ? sha256.toLowerCase() : sha256Of(buffer),
      version: parsed.manifest.version, hostVersion, apiVersion: parsed.manifest.apiVersion,
      publisher: publisherName, signatureVerified, upgraded: upgrading, now
    });
    if (!record.ok) log(`[plugins] ${finalId} 的来源记录没写成功（不影响使用）：${record.error}`);
    log(`[plugins] ${upgrading ? '升级' : '安装'} ${finalId} v${parsed.manifest.version} 完成`
      + `${upgrading ? `（旧版备份在 ${path.basename(backupDir)}）` : ''}`);
    return { ok: true, id: finalId, version: parsed.manifest.version, upgraded: upgrading, backupDir, source: record.ok ? record.source : '' };
  } catch (error) {
    // staging 目录必须清掉：留一堆 .staging-* 下次巡检还以为是插件
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 清不掉就留在那儿，巡检会报出来 */ }
    throw error;
  }
}

/** 升级备份只保留最近 N 份（与 deploy.sh 的快照保留同口径）：不留的话每次升级都堆一份代码。 */
const MAX_BACKUPS = 3;
export function pruneBackups(pluginsRoot, id, now = () => Date.now()) {
  let names = [];
  try { names = fs.readdirSync(pluginsRoot); } catch { return 0; }
  // ⚠️ 分隔符必须是 id 字符集里**不存在**的字符（id 只含 [a-z0-9-]）：写成 `.backup-<id>-` 时，
  // 给 `demo` 升级会把 `demo-tools` 的备份一起纳入排序与删除，最坏是删掉本次升级刚做的回滚点。
  const mine = names.filter((name) => name.startsWith(`.backup-${id}.`)).sort();
  let removed = 0;
  for (const name of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
    try { fs.rmSync(path.join(pluginsRoot, name), { recursive: true, force: true }); removed += 1; }
    catch { /* 删不掉就留着：巡检与控制台都已经会跳过它 */ }
  }
  void now;
  return removed;
}

/**
 * 回退到上一次升级前的版本（升级后跑不起来时的那根救命绳）。
 *
 * 用宿主自己的备份目录：升级时旧版被挪到 `.backup-<id>.<时间戳>-<n>`，这里挑**最新的那一份**，
 * 把当前版本挪到 `.removed-<id>.<时间戳>`（不删，留个后悔的余地），再把备份换回原位。
 * 找不到备份就明确报错（"没得回退"也是有用的信息，别假装成功）。
 */
export function rollbackPlugin({ id, dataDir, now = () => Date.now(), log = () => {} } = {}) {
  const clock = now;
  const name = String(id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw fail('E_ARGS', '插件 id 不合法');
  const root = path.join(dataDir, 'plugins');
  const target = path.join(root, name);
  if (path.dirname(target) !== root) throw fail('E_ARGS', '插件 id 不合法');
  if (!fs.existsSync(target)) throw fail('E_NOT_FOUND', `没有装着 ${name}`);

  let backups = [];
  try {
    // 前缀用 `.backup-<id>.`（id 字符集不含点，所以不会被前缀相同的另一个插件命中）
    backups = fs.readdirSync(root).filter((entry) => entry.startsWith(`.backup-${name}.`)).sort();
  } catch { /* 读不到就是没有 */ }
  if (!backups.length) throw fail('E_NO_BACKUP', `${name} 没有可回退的旧版本（它没被升级过，或备份已经轮转掉了）`);
  const latest = backups[backups.length - 1];   // 名字里带时间戳，字典序即时间序
  const stamp = clock();
  const aside = path.join(root, `.removed-${name}.${stamp}`);
  fs.renameSync(target, aside);
  try {
    fs.renameSync(path.join(root, latest), target);
  } catch (error) {
    if (!fs.existsSync(target)) fs.renameSync(aside, target);   // 换回失败就把当前版本放回原位
    throw fail('E_SWAP', `回退失败，已放回原样：${error?.message ?? error}`);
  }
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8')).version || ''; } catch { /* 读不到就算了 */ }
  // install.json 是"现在装的到底是哪一份"的事实记录：回退后必须跟着改，否则控制台的
  // 「出处与指纹」会继续显示被回退掉的那个版本（2026-10-17 审查 P3）。
  // 备份目录里没有原始包，指纹无法重算 —— 清空并在来源里注明回退自哪个版本。
  try {
    const recordFile = path.join(dataDir, 'plugin-data', name, 'install.json');
    const old = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    writePluginInstallInfo({
      dataDir,
      id: name,
      source: `${String(old.source || '未知来源').slice(0, 90)}（回退自 ${String(old.version || '未知版本')}）`,
      url: old.url,
      sha256: '',
      version,
      hostVersion: old.hostVersion,
      apiVersion: old.apiVersion,
      publisher: old.publisher,
      signatureVerified: old.signatureVerified === true,
      upgraded: true,
      now: clock
    });
  } catch { /* 没有记录或读不出来：不影响回退本身 */ }
  log(`[plugins] ${name} 已回退到 ${latest}（回退掉的版本留在 ${path.basename(aside)}）`);
  return { ok: true, id: name, rolledBackTo: latest, version, removedDir: path.basename(aside) };
}

/** 列出某个插件可回退的备份（控制台显示"可回退到 vX"用）。 */
export function listPluginBackups({ id, dataDir } = {}) {
  const root = path.join(dataDir, 'plugins');
  try {
    return fs.readdirSync(root).filter((entry) => entry.startsWith(`.backup-${String(id ?? '')}.`)).sort();
  } catch { return []; }
}

/**
 * 卸载：**只挪走代码目录**，插件的数据（plugin-data/<id>）保留 ——
 * 按本仓的既有约定（禁用/移除不该顺手删数据），重装后状态还在。
 */
export function uninstallPlugin({ id, dataDir, now = () => Date.now() } = {}) {
  const name = String(id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw fail('E_ARGS', '插件 id 不合法');
  const root = path.join(dataDir, 'plugins');
  const target = path.join(root, name);
  if (path.dirname(target) !== root) throw fail('E_ARGS', '插件 id 不合法');
  if (!fs.existsSync(target)) throw fail('E_NOT_FOUND', `没有装着 ${name}`);
  const removed = path.join(root, `.removed-${name}.${now()}`);   // 同上：用 id 字符集里没有的分隔符
  fs.renameSync(target, removed);
  return { ok: true, id: name, removedDir: removed, dataKept: path.join(dataDir, 'plugin-data', name) };
}

/**
 * 发布者签名（Ed25519，无第三方依赖）。
 *
 * 为什么是"索引里带 publisher + signature，宿主侧登记公钥"而不是一套 PKI：
 * 生态刚起步时代价最小的可信路径是 —— **官方索引由人工审 PR**（谁提的一目了然），
 * 想再加一层密码学证据的人可以用这套：发布者用私钥签包，宿主侧登记它的公钥，安装前验签。
 * 验签只回答"这个包确实是那把私钥的主人发布的"，不回答"该不该信这个人"（那是人工审核的事）。
 *
 * 公钥写法：PEM（`-----BEGIN PUBLIC KEY-----`）或**裸 32 字节**（base64 / hex 都认）——
 * 后者是最常见的形态，省得作者为了统一格式折腾。
 */
export function verifyPluginSignature({ buffer, signature = '', publicKey = '' } = {}) {
  const sig = String(signature ?? '').trim();
  const key = String(publicKey ?? '').trim();
  if (!sig) return { ok: false, error: '没有签名' };
  if (!key) return { ok: false, error: '没有登记该发布者的公钥' };
  if (!buffer?.length) return { ok: false, error: '没有内容可验' };
  let keyObject = null;
  try {
    // PEM 直接交给 createPublicKey；裸 32 字节自己拼 SPKI（那个函数返回的就是 KeyObject，
    // 不能再套一层 createPublicKey —— 实测会报 'Invalid key object type public, expected private'）
    keyObject = key.includes('BEGIN') ? crypto.createPublicKey(key) : rawEd25519ToSpki(decodeKeyBytes(key));
  } catch (error) {
    return { ok: false, error: `公钥读不了：${error?.message ?? error}` };
  }
  const signatureBytes = decodeKeyBytes(sig);
  if (!signatureBytes?.length) return { ok: false, error: '签名不是合法的 base64/hex' };
  try {
    // Ed25519 走 `crypto.verify(null, …)`：算法由密钥类型决定，不能传 'sha256'
    return crypto.verify(null, buffer, keyObject, signatureBytes)
      ? { ok: true, error: '' }
      : { ok: false, error: '签名与包内容对不上（包被改过，或这不是这个包的签名）' };
  } catch (error) {
    return { ok: false, error: `验签失败：${error?.message ?? error}` };
  }
}

/** base64 或 hex → Buffer（两种都试，都不像就返回 null）。 */
function decodeKeyBytes(value) {
  const text = String(value ?? '').trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex');
  const compact = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    try { return Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { return null; }
  }
  return null;
}

/** 裸 32 字节 Ed25519 公钥 → SPKI DER（固定前缀，RFC 8410）。 */
function rawEd25519ToSpki(raw) {
  if (raw.length !== 32) throw new Error(`Ed25519 公钥应是 32 字节，实际 ${raw.length} 字节`);
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

/**
 * 安装来源记录（`plugin-data/<id>/install.json`）：这段代码是从哪来的。
 *
 * 为什么值得单独落一份：插件是第三方代码，出事时第一个要回答的问题就是"它是从哪个索引/哪个地址
 * 装进来的、装的是哪一份"。索引条目会被改、URL 会失效，只有这份记录是当时的事实。
 * 放在 plugin-data（而不是代码目录）里是因为：**升级/卸载都不动数据目录**，来源记录跟着活下来。
 */
export function writePluginInstallInfo({
  dataDir, id, source = '', url = '', sha256 = '', version = '', hostVersion = '',
  apiVersion = null, publisher = '', signatureVerified = false, upgraded = false, now = () => Date.now()
} = {}) {
  const clock = now;   // 注入点先落到本地常量：scan --strict 不认"直接调用解构参数默认值"这种形状
  const record = {
    id: String(id ?? ''),
    version: String(version ?? '').slice(0, 40),
    sha256: String(sha256 ?? '').slice(0, 64),
    source: String(source ?? '').slice(0, 120),
    url: String(url ?? '').slice(0, 500),
    hostVersion: String(hostVersion ?? '').slice(0, 40),
    apiVersion: Number.isInteger(apiVersion) ? apiVersion : null,
    // 谁发的、有没有密码学证据（false = 没登记公钥或没带签名 —— 不是"签名错了"，那会直接拒绝安装）
    publisher: String(publisher ?? '').slice(0, 100),
    signatureVerified: signatureVerified === true,
    upgraded: upgraded === true,
    installedAt: clock()
  };
  try {
    const dir = path.join(dataDir, 'plugin-data', record.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'install.json');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);                 // 与 storage 同口径：写临时文件再原子换入
    return { ok: true, ...record };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), ...record };
  }
}

/** 读回来源记录（读不到就返回 null：老插件、或手工拷进目录的都没有这份记录）。 */
export function readPluginInstallInfo({ dataDir, id } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-data', String(id ?? ''), 'install.json'), 'utf8'));
    return isPlainObject(raw) ? raw : null;
  } catch { return null; }
}

/**
 * 索引条目里"插件包在哪"的字段名。三种叫法都认，按这个顺序取第一个非空值：
 *   · `downloadUrl` —— 我们自己 `plugin-pack` 生成的条目用它（生态惯例：Obsidian / NapCat 都叫这个）；
 *   · `tarball`     —— 本仓最早的索引形状，已有条目在用；
 *   · `url`         —— 手写索引时最自然的写法。
 * 认多种是刻意的：**我们工具生成的条目必须能被我们自己的读取器读出来**（2026-10-16 发现
 * 生成的是 downloadUrl、读取器只认 tarball，于是作者照文档做出来的条目会被静默跳过）。
 */
export const PLUGIN_INDEX_URL_FIELDS = Object.freeze(['downloadUrl', 'tarball', 'url']);

/**
 * 刷新失败时该给前端看什么：**优先"上次成功读到的"**，而不是一个空市场。
 *
 * 为什么：索引默认挂在 GitHub raw 上（第三方托管），从自建服务器拉它偶发超时是常态
 *（2026-10-16 生产实测：同一个 URL 用 curl 2.5s 成功，而控制台那一次超时）；
 * 而索引内容一个月才变几次 —— "这次没拉到"绝不该等于"市场是空的"。
 * 于是失败时回落到上次成功的结果，附上 stale/staleAt/staleReason，界面如实说明。
 *
 * 判据只看"有没有来源成功"：全都失败才回落（多来源时只要有一个拿到了就是新数据）。
 */
export function indexResultForDisplay(fresh, lastGood) {
  const list = Array.isArray(fresh?.plugins) ? fresh.plugins : [];
  const anyOk = Array.isArray(fresh?.sources) && fresh.sources.some((item) => item.ok);
  if (anyOk || list.length) return fresh;
  const fallback = lastGood?.result;
  if (!fallback || !Array.isArray(fallback.plugins) || !fallback.plugins.length) return fresh;
  const reason = (fresh?.sources || []).map((item) => item.error).filter(Boolean)[0] || '未知原因';
  return { ...fallback, stale: true, staleAt: Number(lastGood.at) || 0, staleReason: reason };
}

/**
 * 随程序发布的官方索引快照（`plugins/bundled-index.json`）。
 *
 * 为什么需要：索引默认挂在 GitHub raw 上，国内网络下经常整条拉不动；10 分钟缓存与
 * "上次成功结果"都救不了**首次启动就拉不到**的实例 —— 用户看到的是一张空市场。
 * 这份快照是程序自己发布的（与包内源码的 sha256 对齐），不是第三方镜像，因此可以
 * 作为信任根使用；远端索引能拉到时永远优先用远端，快照只在"全部来源失败且没有上次
 * 成功结果"时兜底。条目不新时最多是"看到旧版本"，不会装到未经验证的包（sha256 仍校验）。
 *
 * 返回形状与 fetchPluginIndexes 一致；读不到文件/形状不对时返回 null（调用方按失败处理）。
 */
let bundledIndexDoc;
export function bundledPluginIndex({ hostVersion = '', apiVersion = PLUGIN_API_VERSION } = {}) {
  if (bundledIndexDoc === undefined) {
    try {
      bundledIndexDoc = JSON.parse(fs.readFileSync(
        new URL('../../plugins/bundled-index.json', import.meta.url), 'utf8'
      ));
    } catch {
      bundledIndexDoc = null;
    }
  }
  if (!bundledIndexDoc) return null;
  const { entries, skipped } = normalizePluginIndex(bundledIndexDoc, {
    apiVersion, hostVersion, source: '内置官方索引'
  });
  if (!entries.length) return null;
  return {
    plugins: entries,
    skipped: skipped.map((item) => ({ ...item, source: '内置官方索引' })),
    sources: [{
      url: 'bundled:official',
      name: '内置官方索引',
      ok: true,
      count: entries.length,
      duplicate: 0,
      skipped: skipped.length,
      error: ''
    }],
    bundled: true
  };
}

/**
 * 索引侧"集中撤回名单"的缓存：把索引结果翻成注册表要的规则（`id@版本` 或 `id`）。
 *
 * 两条 fail-closed 纪律：
 *   ① **全失败不更新**：`fetchPluginIndexes` 对每个来源单独 catch，失败时返回空 plugins。
 *      拿空结果覆盖缓存 = "某个来源拉不动 = 没人被撤回"，被下架的插件会在没有任何提示的情况下恢复。
 *   ② **部分失败只更新成功的那个来源**：多来源时 B 超时、A 正常，A 里没有 X 不代表 B 撤回了 X。
 *      所以规则按来源分开存，只替换本次真的拉到的来源，再取并集。
 *
 * 规则粒度：条目本身是一个版本，`revoked` 撤这一版；整插件下架 = `id`（或给每条都标）。
 * `revokedVersions` 记录历史版本 —— 作者发新版后条目上的 `revoked` 会消失，但旧版仍要被挡。
 */
export function createIndexRevokedCache() {
  // 来源名 -> 该来源的规则。没有 report 的旧调用方走"整份重建"分支。
  const perSource = new Map();
  let rules = [];

  const rulesOf = (entry) => {
    if (!entry?.id) return [];
    const out = [];
    // 索引里的版本可能写成 1.0 / v1.0.0 / 1.0.0+build；与注册表比较前统一规范化，
    // 否则一条 demo@1.0 的撤回规则对已安装的 1.0.0 完全不起作用（2026-10-17 审查 P2）
    if (entry.revoked) out.push(versionRule(entry.id, entry.version));
    for (const version of entry.revokedVersions || []) out.push(versionRule(entry.id, version));
    return out;
  };

  return {
    /** 用一次索引拉取结果更新；返回更新后的规则（全失败时原样返回旧规则）。 */
    update(result = {}) {
      const reports = Array.isArray(result.sources) ? result.sources : [];
      const anySourceOk = reports.some((item) => item.ok);
      // 没有 report 时按旧口径判断（保持对既有调用方的兼容）
      if (!anySourceOk && reports.length) return rules;   // 拉不动 ≠ 没撤回
      if (!anySourceOk && !reports.length && !Array.isArray(result.plugins)) return rules;

      const fresh = Array.isArray(result.revoked) ? result.revoked : null;
      if (!fresh) {
        // 旧调用方：只有合并后的 plugins，无法分来源 —— 整份重建（与修复前的行为一致）
        perSource.clear();
        const next = [];
        for (const entry of Array.isArray(result.plugins) ? result.plugins : []) next.push(...rulesOf(entry));
        perSource.set('', next);
      } else {
        // 按 **URL** 做键而不是展示名：两个来源都叫「官方索引」（默认源 + 一个同名 fork）
        // 时，用名字做键会让后者的规则永远覆盖/丢失前者（2026-10-17 审查 P2）
        const configured = new Set(reports.map((item) => String(item.url || item.name || '')));
        for (const key of [...perSource.keys()]) {
          if (key && !configured.has(key)) perSource.delete(key);   // 来源被移除：规则一并失效
        }
        for (const item of reports) {
          if (!item.ok) continue;                        // 这个来源这次没拉到：保住它上次的规则
          const key = String(item.url || item.name || '');
          // 新报告带 url；旧调用方只有 source。优先按 url 匹配，缺失时退回名字
          const found = fresh.find((entry) => (entry.url
            ? String(entry.url) === key
            : String(entry.source || '') === String(item.name || '')));
          perSource.set(key, found ? found.rules.slice() : []);
        }
      }
      rules = [...new Set([...perSource.values()].flat())];
      return rules;
    },
    rules: () => rules,
    /** 只读快照（调试/用例用）：来源 → 该来源的规则。 */
    bySource: () => new Map(perSource)
  };
}

/**
 * 只接受 http(s) 的地址字段：索引由第三方提供（plugins.indexUrls 可挂别人的索引），形状不对就置空
 * —— 界面会优雅降级（不出链接），比"链到 javascript: 上"安全得多。
 */
const httpUrl = (value) => (/^https?:\/\//i.test(String(value ?? '').trim()) ? String(value).trim().slice(0, 300) : '');

const INDEX_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const INDEX_SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 版本文本归一化：剥掉前导 v/V，形状不对返回 ''（调用方按 fail-closed 处理）。 */
function normalizeVersionText(value) {
  const text = String(value ?? '').trim().replace(/^[vV]/, '');
  return INDEX_SEMVER_RE.test(text) ? text : '';
}

/**
 * 展示用版本号：索引是第三方内容源，`version` 会被拼进控制台按钮文案（"升级到 v…"）。
 * 不校验形状时，`9.0.0"><img src=x onerror=…>` 能一路走到 innerHTML 里（界面还会再转义一道，
 * 但"能带进去"本身就不该开门）。规则：先按 semver 归一化；不是 semver 就只留开头那段版本数字
 * （作者常写 `1.0`）；都取不到就置空 —— 置空只是不显示升级提示，不影响安装。
 */
function safeVersionText(value) {
  const normalized = normalizeVersionText(value);
  if (normalized) return normalized;
  const lead = /^\d+(?:\.\d+){0,2}/.exec(String(value ?? '').trim().replace(/^[vV]/, ''));
  return lead ? lead[0].slice(0, 40) : '';
}

/** 只比主干三段（门控只关心"本机版本够不够"，预发布标签不参与）。 */
function compareSemver(a, b) {
  const parts = (value) => String(value).split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 把索引里的一项归一化成入口条目。**纯函数**（不碰网络、不碰磁盘）：控制台、校验脚本与用例
 * 共用同一份口径，避免"控制台能装、脚本说不行"这种两套判据。
 *
 * 装不了的条目**不丢**：标 `compatible:false` 并给出原因，让界面能显示"看得见但装不了，
 * 因为它要 apiVersion 2 / 宿主 ≥ 0.9.0"。悄悄消失的条目对作者和用户都是最坏的反馈。
 */
export function normalizePluginIndexEntry(item, { apiVersion = PLUGIN_API_VERSION, hostVersion = '', source = '' } = {}) {
  if (!isPlainObject(item)) return { ok: false, id: '', reason: '索引里这一项不是对象' };
  const id = String(item.id ?? '').trim();
  if (!INDEX_ID_RE.test(id)) return { ok: false, id, reason: `id 不合法：${JSON.stringify(item.id ?? '')}` };
  let url = '';
  for (const field of PLUGIN_INDEX_URL_FIELDS) {
    const value = String(item[field] ?? '').trim();
    if (value) { url = value; break; }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, id, reason: `缺少可下载地址（要有 ${PLUGIN_INDEX_URL_FIELDS.join(' / ')} 之一，且是 http(s)）` };
  }
  const sha = String(item.sha256 ?? '').trim().toLowerCase();
  if (!isSha256(sha)) return { ok: false, id, reason: 'sha256 必须是 64 位十六进制（没有内容锚点就不许安装）' };
  const declaredApi = item.apiVersion === undefined || item.apiVersion === null ? null : Number(item.apiVersion);
  const minVersion = String(item.minVersion ?? '').trim();
  const entry = {
    id,
    name: String(item.name ?? id).slice(0, 100),
    version: safeVersionText(item.version),
    description: String(item.description ?? '').slice(0, 300),
    author: String(item.author ?? '').slice(0, 100),
    // 发布者与签名：登记过公钥的发布者由宿主在安装时验签（见 verifyPluginSignature）
    publisher: String(item.publisher ?? '').slice(0, 100),
    signature: String(item.signature ?? '').slice(0, 200),
    // 主页/说明/更新日志这三个地址也会被控制台做成可点的 <a>：只收 http(s)（与 icon、screenshots、
    // mirrors 同一口径）。esc() 只挡标签不挡 scheme，`javascript:` 能一路走到详情页的 href 上
    homepage: httpUrl(item.homepage),
    tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string').slice(0, 12) : [],
    capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((c) => typeof c === 'string') : [],
    // ── 市场呈现用的可选字段（缺了不影响装，界面优雅降级）────────────────────────
    // 索引是"市场"的内容源：光有 id/描述撑不起一个市场，得有图标、说明、更新日志这些。
    // 图标地址：只收 http(s)（与截图同一个口径）。原来是"只截长度" —— 索引里写 `javascript:` 之类
    // 会被原样带进界面，虽然界面只认 https 会降级成字母块，但"能带进去"本身就是不该开的门
    icon: /^https?:\/\//i.test(String(item.icon ?? '').trim()) ? String(item.icon).trim().slice(0, 300) : '',
    screenshots: Array.isArray(item.screenshots)
      ? item.screenshots.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 6) : [],
    readme: String(item.readme ?? '').slice(0, 4000),            // 详情页正文（纯文本，界面转义后按段落显示）
    readmeUrl: httpUrl(item.readmeUrl),
    changelogUrl: httpUrl(item.changelogUrl),
    category: String(item.category ?? '').slice(0, 40),
    size: Number.isFinite(Number(item.size)) && Number(item.size) > 0 ? Math.floor(Number(item.size)) : 0,
    // 下面两个由索引侧的定时任务写回（我们不猜、也不让作者手填）：下载量与最后更新时间
    downloads: Number.isFinite(Number(item.downloads)) && Number(item.downloads) >= 0 ? Math.floor(Number(item.downloads)) : 0,
    updatedAt: String(item.updatedAt ?? '').slice(0, 40),
    // ── 集中下架：索引里标了 revoked，宿主读到就拒载（不再需要每台机器改配置）──────
    revoked: item.revoked === true ? (String(item.revokedReason ?? '').slice(0, 200) || '索引里已撤回') : '',
    // 撤回过的**历史版本**：索引一个 id 只列一个版本，作者修好并发新版后，条目上的 `revoked` 就没了，
    // 而还装着旧版的机器会因此重新跑起来。把旧版本记在这里，规则里继续挡（发布脚本会自动写回）。
    revokedVersions: Array.isArray(item.revokedVersions)
      ? [...new Set(item.revokedVersions.map((v) => safeVersionText(v)).filter(Boolean))].slice(0, 50) : [],
    deprecated: item.deprecated === true ? (String(item.deprecatedReason ?? '').slice(0, 200) || '已弃用') : '',
    url,
    // 条目里显式给的备用地址（走镜像/CDN 的那一份）。取包时按 [url, ...mirrors, 派生镜像] 顺序试。
     mirrors: Array.isArray(item.mirrors) ? item.mirrors.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 5) : [],
    sha256: sha,
    apiVersion: declaredApi,
    minVersion,
    source: String(source ?? ''),
    compatible: true,
    reason: ''
  };
  if (entry.revoked) {
    // 被撤回的条目**留着**（界面要能显示"它被撤回了、为什么"），但一律标成装不了
    entry.compatible = false;
    entry.reason = `已被撤回：${entry.revoked}`;
  } else if (declaredApi !== null && (!Number.isInteger(declaredApi) || declaredApi !== apiVersion)) {
    entry.compatible = false;
    entry.reason = `插件要求 apiVersion ${Number.isInteger(declaredApi) ? declaredApi : JSON.stringify(item.apiVersion)}，本机只支持 ${apiVersion}`;
  } else if (minVersion) {
    // 归一化前导 v（作者最自然的写法之一）：**不能因为形状不标准就跳过门控** ——
    // 那等于"拼错一个字符就把闸门拆了"。归一化后还不是版本号 → 明确标成装不了（fail-closed）。
    const wanted = normalizeVersionText(minVersion);
    if (!wanted) {
      entry.compatible = false;
      entry.reason = `minVersion 形状不对（${JSON.stringify(minVersion)}），无法判断能不能跑`;
    } else if (hostVersion && compareSemver(hostVersion, wanted) < 0) {
      entry.compatible = false;
      entry.reason = `插件要求宿主 ≥ ${minVersion}，本机是 ${hostVersion}`;
    }
  }
  return { ok: true, entry };
}

/** 归一化整份索引：`{ entries, skipped, version }`。坏项进 skipped 并带上原因（要能追责）。 */
export function normalizePluginIndex(parsed, { apiVersion = PLUGIN_API_VERSION, hostVersion = '', source = '' } = {}) {
  const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : null;
  if (!plugins) throw fail('E_INDEX', '索引里没有 plugins 数组');
  const entries = [];
  const skipped = [];
  for (const item of plugins) {
    const result = normalizePluginIndexEntry(item, { apiVersion, hostVersion, source });
    if (result.ok) entries.push(result.entry);
    else skipped.push({ id: result.id, reason: result.reason });
  }
  return { entries, skipped, version: Number(parsed?.version) || 0 };
}

/**
 * 拉一份索引（一份 JSON）。
 * 用 safe-fetch：索引地址是用户填的 URL，内网/SSRF/体积/超时都要挡住（与 web_fetch 同一套守卫）。
 */
export async function fetchPluginIndex({ url, name = '', fetchText, log = () => {}, hostVersion = '', apiVersion = PLUGIN_API_VERSION } = {}) {
  const grab = fetchText;   // 同上：别直接调用解构参数的默认值
  const target = String(url ?? '').trim();
  if (!target) throw fail('E_ARGS', '没有配置索引地址');
  if (typeof fetchText !== 'function') throw fail('E_NO_FETCH', '没有可用的抓取实现');
  const result = await grab(target);
  if (Number(result?.statusCode) !== 200) throw fail('E_INDEX', `索引拉取失败：HTTP ${result?.statusCode ?? '?'}`);
  // 截断必须明说：截断后的 JSON 一定解析失败，若只报"不是合法 JSON"，会把"索引太大了"
  // 误导成"索引写坏了"（而且首次加载时市场直接变空，只剩一句看不懂的原因）。
  if (result?.truncated) throw fail('E_INDEX', '索引超过体积上限被截断：请缩减 readme 长度，或把索引拆成多份（plugins.indexUrls 支持多个来源）');
  let parsed = null;
  try { parsed = JSON.parse(String(result?.body ?? '')); } catch { throw fail('E_INDEX', '索引不是合法 JSON'); }
  const label = String(name ?? '').trim() || target;
  const { entries, skipped } = normalizePluginIndex(parsed, { apiVersion, hostVersion, source: label });
  for (const item of skipped) log(`[plugins] 索引 ${label} 里这一项用不了，已跳过 —— ${item.id || '(没有 id)'}：${item.reason}`);
  // skipped 一并返回：只写日志的话界面上永远不会出现"某条缺字段被跳过"，与页面文案不符
  return { entries, skipped: skipped.map((item) => ({ ...item, source: label })) };
}

/**
 * 多份索引合并（`plugins.indexUrls` 是数组）。规则写死三条，避免"到底谁说了算"含糊：
 *   1. **按配置顺序**：排在前面的来源优先，同 id 只留第一份；
 *   2. **一份拉不动不影响其余**：每个来源的结果单独记录（ok/error/条数），界面按来源显示；
 *   3. 落选的条目不是消失，而是进 skipped 并注明与谁重复 —— 排查"我明明上架了却不显示"时有据可查。
 */
export async function fetchPluginIndexes({
  sources = [], fetchText, log = () => {}, hostVersion = '', apiVersion = PLUGIN_API_VERSION
} = {}) {
  const plugins = [];
  const skipped = [];
  const report = [];
  const revoked = [];
  const owner = new Map();
  const prepared = sources
    .map((item) => ({
      url: String(item?.url ?? '').trim(),
      name: String(item?.name ?? '').trim() || String(item?.url ?? '').trim()
    }))
    .filter((item) => item.url);
  // 并发拉取：串行时 N 个来源的最坏耗时是 N ×（DNS 5s + 读超时 20s），点一下要等好几十秒；
  // 单个来源的失败互不影响，合并仍在下面**按配置顺序**做（顺序 = 优先级，不能乱）
  const outcomes = await Promise.all(prepared.map(async (item) => {
    try {
      const { entries, skipped: badEntries } = await fetchPluginIndex({
        url: item.url, name: item.name, fetchText, log, hostVersion, apiVersion
      });
      return { ...item, ok: true, entries, badEntries };
    } catch (error) {
      return { ...item, ok: false, error: String(error?.message ?? error) };
    }
  }));
  for (const outcome of outcomes) {
    const { url, name } = outcome;
    if (!outcome.ok) {
      report.push({ url, name, ok: false, count: 0, duplicate: 0, skipped: 0, error: outcome.error });
      log(`[plugins] 索引「${name}」拉取失败：${outcome.error}`);
      continue;
    }
    const { entries, badEntries } = outcome;
    skipped.push(...badEntries);
    // 撤回规则要在**去重之前**收：同一 id 在多份索引里出现时，后一份的条目会落选，
    // 但它在自己那份索引里标的撤回仍然算数（否则"重名"就成了一条绕过下架的路）。
    const rules = [];
    for (const entry of entries) {
      if (entry.revoked) rules.push(versionRule(entry.id, entry.version));
      for (const version of entry.revokedVersions || []) rules.push(versionRule(entry.id, version));
    }
    revoked.push({ source: name, url, rules: [...new Set(rules)] });
    let kept = 0;
    let duplicate = 0;
    for (const entry of entries) {
      const first = owner.get(entry.id);
      if (first) {
        duplicate += 1;
        skipped.push({ id: entry.id, source: name, reason: `与「${first}」里的同名条目重复（按来源顺序取靠前的那份）` });
        continue;
      }
      owner.set(entry.id, name);
      plugins.push(entry);
      kept += 1;
    }
    report.push({ url, name, ok: true, count: kept, duplicate, skipped: badEntries.length, error: '' });
  }
  return { plugins, skipped, sources: report, revoked };
}
