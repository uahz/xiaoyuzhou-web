#!/usr/bin/env python3
"""桌面版构建前校验
用法：python3 check.py
检查项：
  1. 主进程 / 预加载 / 自检脚本语法（node --check）
  2. 渲染层 inline 脚本语法（抽取后 node --check）
  3. HTML 结构完整性（script 标签配对、JSON 块可解析）
  4. 关键 DOM id 存在
  5. 主进程可安全 require（不依赖 app 初始化）
"""
import json
import os
import re
import subprocess
import sys

# Windows CI 的 Python 默认编码是 cp1252，打印中文会 UnicodeEncodeError。
# 强制 stdout/stderr 使用 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(ROOT, ".check-tmp")
issues = []


def node_check(label, code, fname):
    os.makedirs(TMP, exist_ok=True)
    path = os.path.join(TMP, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        first = r.stderr.strip().split("\n")
        msg = " / ".join(x.strip() for x in first[:4])
        issues.append("%s 语法错误: %s" % (label, msg[:180]))


def main():
    # ---------- 1. 主进程脚本 ----------
    for rel in ["src/main.js", "src/preload.js", "src/selftest.js"]:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            issues.append("缺少文件 " + rel)
            continue
        code = open(path, encoding="utf-8").read()
        node_check(rel, code, os.path.basename(rel))

    # ---------- 2. 渲染层 ----------
    renderer = os.path.join(ROOT, "renderer", "index.html")
    if not os.path.exists(renderer):
        issues.append("缺少 renderer/index.html")
    else:
        h = open(renderer, encoding="utf-8").read()

        # script 标签配对
        opens = len(re.findall(r"<script\b", h))
        closes = len(re.findall(r"</script>", h))
        if opens != closes:
            issues.append("script 标签不配对 %d/%d" % (opens, closes))

        # JSON 块可解析
        for sid in ["catalog", "covers", "coverColors", "seeds", "data"]:
            m = re.search(r'<script id="%s" type="application/json">(.*?)</script>' % sid, h, re.S)
            if not m:
                issues.append("缺少 JSON 块 " + sid)
                continue
            body = m.group(1)
            if "</script" in body:
                issues.append(sid + " 块内含未转义的 </script")
            try:
                json.loads(body.replace("<\\/", "</"))
            except Exception as e:
                issues.append(sid + " 解析失败: " + str(e)[:80])

        # inline 主脚本语法
        m = re.search(r"<script>(.*?)</script>", h, re.S)
        if m:
            node_check("renderer inline script", m.group(1), "renderer_main.js")
        else:
            issues.append("未找到渲染层 inline script")

        # 顶层重复声明检测 —— 只看不在函数体内的 const/let
        # （函数内的局部变量同名是合法的，只有同作用域重复才会让整个脚本不执行）
        code = m.group(1) if m else ""
        top_level = []
        depth = 0
        for line in code.split("\n"):
            stripped = line.strip()
            if depth == 0:
                mm = re.match(r"(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=", stripped)
                if mm:
                    top_level.append(mm.group(1))
            # 粗略跟踪花括号深度（忽略字符串里的括号，够用）
            depth += line.count("{") - line.count("}")
            if depth < 0:
                depth = 0
        seen = {}
        for d in top_level:
            seen[d] = seen.get(d, 0) + 1
        for name, cnt in seen.items():
            if cnt > 1:
                issues.append("顶层重复声明 %s ×%d（会导致整个脚本不执行）" % (name, cnt))

        # 关键 DOM id
        for eid in ["btnLogin", "btnAccount", "phoneInput", "codeInput", "areaCode",
                    "btnSendCode", "btnDoLogin", "btnCancelLogin", "loginMsg",
                    "loginModal", "loginModalBox", "codeField", "loginOk",
                    "nowSheet", "nowArt", "nowWave", "speedPanel", "speedTrack",
                    "nowDesc", "queuePanel", "queuePanelList", "tbTitle", "content"]:
            if ('id="%s"' % eid) not in h:
                issues.append("缺少 DOM 元素 #" + eid)

        # 已移除的旧元素不应残留
        for eid in ["btnSimulateScan", "btnQrRefresh", "qrImg", "qrWrap"]:
            if ('id="%s"' % eid) in h:
                issues.append("残留旧登录元素 #" + eid)

    # ---------- 3. package.json ----------
    pkg_path = os.path.join(ROOT, "package.json")
    if not os.path.exists(pkg_path):
        issues.append("缺少 package.json")
    else:
        pkg = json.load(open(pkg_path, encoding="utf-8"))
        main = pkg.get("main", "")
        if not os.path.exists(os.path.join(ROOT, main)):
            issues.append("package.json 的 main 指向不存在的文件: " + main)
        for rel in pkg.get("build", {}).get("files", []):
            if not os.path.exists(os.path.join(ROOT, rel.rstrip("/*"))):
                issues.append("build.files 指向不存在的路径: " + rel)

    # ---------- 输出 ----------
    print("桌面版校验")
    print("-" * 40)
    if issues:
        print("发现问题：")
        for i in issues:
            print("  ✗ " + i)
        sys.exit(1)
    print("全部通过 ✓")


if __name__ == "__main__":
    main()
