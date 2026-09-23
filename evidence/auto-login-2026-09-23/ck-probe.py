# 只读取证：把 profile 的 Cookies 库拷一份出来，看淘宝/阿里妈妈/天猫的 cookie
# 到底是「持久 cookie」（能扛重启）还是「会话 cookie」（进程一没就丢）。
# 只读，不改任何东西；拷贝到 tmp/ 再读，避免动到浏览器正在用的库。
import os
import shutil
import sqlite3

PROFILES = [
    ("里可林淘宝", "D:/Retire/edge-profiles/likelin-home"),
    ("网林天猫", "D:/Retire/edge-profiles/wanglin-flagship"),
    ("盖文淘宝", "D:/Retire/edge-profiles/suixin-custom"),
    ("盖文天猫", "D:/Retire/edge-profiles/gaiwen-flagship"),
    ("科塔淘宝", "D:/Retire/edge-profiles/shop-j873522735"),
    ("商家浏览器", "D:/Retire/edge-daily-report-profile"),
]
KEYS = ("sn", "unb", "cookie2", "_tb_token_", "sgcookie", "cna", "t", "_l_g_", "havana_lgc2_77", "cookie17")
DOMAIN_LIKE = ("%taobao.com", "%alimama.com", "%tmall.com")

for name, prof in PROFILES:
    src = os.path.join(prof, "Default", "Network", "Cookies")
    print("=" * 70)
    print("%s   %s" % (name, src))
    if not os.path.exists(src):
        print("  没有 Cookies 文件")
        continue
    tag = os.path.basename(prof)
    dst = "tmp/ck-%s.db" % tag
    shutil.copyfile(src, dst)
    for ext in ("-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copyfile(src + ext, dst + ext)
    con = sqlite3.connect(dst)
    cur = con.cursor()
    total = cur.execute("SELECT COUNT(*) FROM cookies").fetchone()[0]
    print("  库里 cookie 总数 = %d" % total)
    for dom in DOMAIN_LIKE:
        rows = cur.execute(
            "SELECT host_key, name, is_persistent, has_expires, expires_utc, length(encrypted_value) "
            "FROM cookies WHERE host_key LIKE ? ORDER BY host_key, name",
            (dom,),
        ).fetchall()
        pers = [r for r in rows if r[2] == 1]
        sess = [r for r in rows if r[2] == 0]
        print("  %-16s 共 %3d 条 ｜ 持久 %3d ｜ 会话 %3d" % (dom, len(rows), len(pers), len(sess)))
        named = [r for r in rows if r[1] in KEYS]
        for host, n, p, he, ex, blen in named:
            print("      %-28s %-16s persistent=%s has_expires=%s len=%d" % (host, n, p, he, blen))
    con.close()
