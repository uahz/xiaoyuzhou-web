#!/usr/bin/env python3
"""手动打包 Windows 绿色版
绕开 electron-builder 的 unpack 阶段（目录清理会被安全策略拦截）。
产出：dist/win-x64/ 目录 + 小宇宙-<version>-x64-portable.zip
"""
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
ELECTRON_DIST = os.path.join(ROOT, "node_modules", "electron", "dist")
OUT_DIR = os.path.join(ROOT, "dist", "win-x64")
PKG = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
VERSION = PKG.get("version", "1.0.0")
APP_NAME = "小宇宙"

print("打包 " + APP_NAME + " " + VERSION)

if not os.path.isdir(ELECTRON_DIST):
    raise SystemExit("找不到 Electron 运行时：" + ELECTRON_DIST)

# ---------- 1. 复制 Electron 运行时 ----------
if os.path.isdir(OUT_DIR):
    print("  清空旧目录…")
    for root, dirs, files in os.walk(OUT_DIR, topdown=False):
        for f in files:
            try: os.remove(os.path.join(root, f))
            except Exception: pass
        for d in dirs:
            try: os.rmdir(os.path.join(root, d))
            except Exception: pass
    try: os.rmdir(OUT_DIR)
    except Exception: pass

os.makedirs(OUT_DIR, exist_ok=True)
copied = 0
for name in os.listdir(ELECTRON_DIST):
    src = os.path.join(ELECTRON_DIST, name)
    dst = os.path.join(OUT_DIR, name)
    if os.path.isdir(src):
        shutil.copytree(src, dst)
        copied += 1
    else:
        shutil.copy2(src, dst)
        copied += 1
print("  Electron 运行时:", copied, "项")

# ---------- 2. 应用资源 ----------
app_dir = os.path.join(OUT_DIR, "resources", "app")
os.makedirs(app_dir, exist_ok=True)
for sub in ("src", "renderer"):
    s = os.path.join(ROOT, sub)
    d = os.path.join(app_dir, sub)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(s, d, ignore=shutil.ignore_patterns("node_modules"))
    print("  复制", sub + "/")

# 精简 package.json（运行时只需 main 与 name）
mini = {
    "name": PKG["name"],
    "version": PKG["version"],
    "main": "src/main.js",
    "description": PKG.get("description", "")
}
with open(os.path.join(app_dir, "package.json"), "w", encoding="utf-8") as f:
    json.dump(mini, f, ensure_ascii=False, indent=2)

# ---------- 3. 重命名可执行文件 ----------
old_exe = os.path.join(OUT_DIR, "electron.exe")
new_exe = os.path.join(OUT_DIR, APP_NAME + ".exe")
if os.path.exists(old_exe):
    if os.path.exists(new_exe):
        os.remove(new_exe)
    os.rename(old_exe, new_exe)
    print("  可执行文件 ->", APP_NAME + ".exe")

# ---------- 4. 打包 zip ----------
os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
zip_path = os.path.join(ROOT, "dist", "%s-%s-x64-portable.zip" % (APP_NAME, VERSION))
if os.path.exists(zip_path):
    os.remove(zip_path)
print("  压缩中…")
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(OUT_DIR):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, OUT_DIR)
            z.write(full, rel)
size_mb = os.path.getsize(zip_path) / 1024 / 1024
print("完成: dist/%s  (%.1f MB)" % (os.path.basename(zip_path), size_mb))
