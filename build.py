#!/usr/bin/env python3
"""构建脚本：注入数据 → 生成 index.html → 安全自检
用法：python3 build.py
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(ROOT, "tmp")

def js(o):
    """安全序列化：转义 < > & 以免在 script 块内提前闭合标签"""
    s = json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    s = s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return s.replace("</", "<\\/")

def load(name):
    with open(os.path.join(TMP, name), encoding="utf-8") as f:
        return json.load(f)

def main():
    tpl = open(os.path.join(ROOT, "build", "template.html"), encoding="utf-8").read()
    data = load("data.json")
    cat = load("catalog_index.json")
    seed = load("seed_ids.json")
    cov = load("covers.json")
    cols = load("cover_colors.json")

    scripts = (
        '<script id="catalog" type="application/json">' + js(cat) + '</script>\n'
        '<script id="covers" type="application/json">' + js(cov) + '</script>\n'
        '<script id="coverColors" type="application/json">' + js(cols) + '</script>\n'
        '<script id="seeds" type="application/json">' + js(seed) + '</script>\n'
    )
    out = tpl.replace('<script id="data" type="application/json">',
                       scripts + '<script id="data" type="application/json">', 1)
    out = out.replace("__DATA__", js(data), 1)
    out = out.replace("const CATALOG = (typeof CATALOG_INDEX !== 'undefined') ? CATALOG_INDEX : [];",
                       "const CATALOG = JSON.parse(document.getElementById('catalog').textContent);")
    out = out.replace("const CATALOG_COVER = (typeof COVER_MAP !== 'undefined') ? COVER_MAP : {};",
                       "const CATALOG_COVER = JSON.parse(document.getElementById('covers').textContent);")
    out = out.replace("const SEED_IDS = (typeof SEED_LIST !== 'undefined') ? SEED_LIST : [];",
                       "const SEED_IDS = JSON.parse(document.getElementById('seeds').textContent);")

    path = os.path.join(ROOT, "build", "xiaoyuzhou-mac.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)

    # ---------------- 安全自检 ----------------
    issues = []
    h = open(path, encoding="utf-8").read()

    # 1) script 标签配对
    opens = len(re.findall(r'<script\b', h))
    closes = len(re.findall(r'</script>', h))
    if opens != closes:
        issues.append("script 标签不配对 %d/%d" % (opens, closes))

    # 2) 每个 JSON 块可解析
    parsed = {}
    for sid in ["catalog", "covers", "coverColors", "seeds", "data"]:
        m = re.search(r'<script id="%s" type="application/json">(.*?)</script>' % sid, h, re.S)
        if not m:
            issues.append("缺少 JSON 块 " + sid); continue
        body = m.group(1)
        if "</script" in body:
            issues.append(sid + " 块内含未转义的 </script")
        try:
            parsed[sid] = json.loads(body.replace("<\\/", "</"))
        except Exception as e:
            issues.append(sid + " 解析失败: " + str(e)[:70])

    # 3) pid 合法性（24 位小写 hex）
    if "catalog" in parsed:
        bad = [c for c in parsed["catalog"]
               if not (isinstance(c[0], str) and len(c[0]) == 24
                       and all(ch in "0123456789abcdef" for ch in c[0]))]
        if bad:
            issues.append("catalog 有 %d 条非法 pid（例：%s）" % (len(bad), bad[0][0][:28]))

    # 4) 主 script 语法 —— 用 node --check 做权威校验
    #    （不能用括号计数：字符串字面量里的括号会误报）
    m = re.search(r'<script>(.*?)</script>', h, re.S)
    if m:
        js_path = os.path.join(TMP, "_main_check.js")
        with open(js_path, "w", encoding="utf-8") as f:
            f.write(m.group(1))
        import subprocess
        r = subprocess.run(["node", "--check", js_path], capture_output=True, text=True)
        if r.returncode != 0:
            issues.append("主 script 语法错误: " + (r.stderr.strip().split(chr(10))[0][:90]))
    else:
        issues.append("未找到主 script 块")

    # 5) 关键 DOM id 存在
    for eid in ["btnNowClose","btnNowPlay","btnNowBack","btnNowFwd","btnNowSpeed",
                "btnNowFav","btnNowPod","btnNowInfo","btnNowList","btnNowTheme",
                "btnQueuePanelClose","nowSheet","nowWave","nowArt","nowDesc",
                "queuePanel","queuePanelList"]:
        if ('id="%s"' % eid) not in h:
            issues.append("缺少 DOM 元素 #" + eid)

    print("built: %s (%d KB)" % (path, os.path.getsize(path) // 1024))
    print("script tags: %d/%d  | catalog: %d 条 | seeds: %d" %
          (opens, closes, len(parsed.get("catalog", [])), len(parsed.get("seeds", []))))
    if issues:
        print("\n构建自检未通过：")
        for i in issues:
            print("  ✗ " + i)
        sys.exit(1)
    print("构建自检通过 ✓")

if __name__ == "__main__":
    main()
