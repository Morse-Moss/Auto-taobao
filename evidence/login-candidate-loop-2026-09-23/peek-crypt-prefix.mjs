// 只读：`logins.password_value` 的**加密前缀**。
//
// 为什么这一列最要紧（2026-09-23）：
//   一次性实例实验（probe-throwaway-autofill.mjs，A 组）已经拿到：复制商家浏览器的 profile、
//   打开登录页、连真实鼠标点击 + 真实按键都不填。但复制件有个必须排除的混淆 ——
//   **复制件的凭据能不能被这版 Edge 解开**。而 Chromium 的密码密文前缀恰好把这件事写在明面上：
//     · `v10` —— 老方案：AES-256-GCM，密钥放在 `Local State` 的 `os_crypt.encrypted_key`
//                 （DPAPI 包一层）。同机同用户复制到哪都能解开。
//     · `v20` —— **App-Bound Encryption（Edge/Chrome 127+ 引入）**：密钥绑到浏览器安装路径 +
//                 用户 SID + 一个只在浏览器进程内可用的服务。解不开时的表现**不是报错**，
//                 而是密码管理器**静默地不把这条凭据当成候选** —— 既不下拉、也不填，
//                 页面上读到的一切都正常。这正好是我们在真机上看到的形态。
//     · `v11` —— 少数平台用；本机不该出现。
//   所以「前缀是 v10 还是 v20」直接决定下一步该往哪查：v10 ⇒ 解密不是成因；
//   v20 ⇒ 必须回答「这版 Edge 现在还能不能解开它自己的 v20 密文」。
//
// 只读前 3 个字节的十六进制，**绝不读也绝不打印完整密文、绝不尝试还原明文**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILES = [
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['里可林淘宝', 'D:/Retire/edge-profiles/likelin-home'],
  ['网林天猫', 'D:/Retire/edge-profiles/wanglin-flagship'],
  ['科塔淘宝', 'D:/Retire/edge-profiles/shop-j873522735'],
  ['盖文淘宝', 'D:/Retire/edge-profiles/suixin-custom'],
  ['商家浏览器', 'D:/Retire/edge-daily-report-profile'],
];

function openLoginData(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    return { db, note: '原库' };
  } catch {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cryptpfx-')), 'Login Data');
    fs.copyFileSync(file, copy);
    return { db: new DatabaseSync(copy, { readOnly: true }), note: '复制件（原库被浏览器锁着）' };
  }
}

const decode = (hex) => {
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return { prefix: String.fromCharCode(...bytes.slice(0, 3)), length: bytes.length };
};
const shift = (n) => (n === 1 ? 1 : n * 2);

let counts = {};
for (const [name, dir] of PROFILES) {
  console.log(`\n== ${name}`);
  for (const which of ['Default/Login Data', 'Default/Login Data For Account']) {
    const file = `${dir}/${which}`;
    if (!fs.existsSync(file)) continue;
    const { db, note } = openLoginData(file);
    const rows = db.prepare('SELECT username_value, signon_realm, length(password_value) AS n,'
      + ' hex(substr(password_value, 1, 3)) AS h FROM logins').all();
    db.close();
    const taobao = rows.filter((r) => String(r.signon_realm).includes('taobao.com'));
    console.log(`   [${which}] ${rows.length} 行（${note}）；其中淘宝 ${taobao.length} 条`);
    for (const row of taobao) {
      const { prefix, length } = decode(String(row.h));
      counts[prefix] = (counts[prefix] ?? 0) + 1;
      const plaintext = length === 0 ? '空' : String(shift(length - 3 - 12 - 16));
      console.log(`     ${prefix}  密文 ${length} 字节（明文长度≈${plaintext}）  ${JSON.stringify(String(row.username_value))}@${row.signon_realm}`);
    }
  }
}
console.log(`\n前缀统计：${JSON.stringify(counts)}`);
console.log('v10 ⇒ 老方案，同机同用户可解；v20 ⇒ 应用绑定加密，解不开时密码管理器会静默不提供该凭据。');
