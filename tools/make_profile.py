"""Builds profiles/T3 Code.streamDeckProfile for Stream Deck+ (model 20GBD9901)."""
import json, uuid, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = "io.github.antoinersx.t3codedeck"
VERSION = json.loads((ROOT / "io.github.antoinersx.t3codedeck.sdPlugin" / "manifest.json").read_text())["Version"]
OUT = ROOT / "io.github.antoinersx.t3codedeck.sdPlugin" / "profiles" / "T3 Code.streamDeckProfile"

def action(name, suffix):
    return {
        "ActionID": str(uuid.uuid4()), "LinkedTitle": False, "Name": name,
        "Plugin": {"Name": "T3 Code Deck", "UUID": PLUGIN, "Version": VERSION},
        "Resources": None, "Settings": {}, "State": 0,
        "States": [{"FontFamily": "", "FontSize": 12, "FontStyle": "", "FontUnderline": False, "OutlineThickness": 2,
                    "ShowTitle": False, "TitleAlignment": "bottom", "TitleColor": "#ffffff"}],
        "UUID": f"{PLUGIN}.{suffix}",
    }

def main():
    profile_id, page_id, default_id = (str(uuid.uuid4()).upper() for _ in range(3))
    keys = {f"{col},{row}": action("Thread", "thread") for row in range(2) for col in range(4)}
    dials = {f"{i},0": action(n, s) for i, (n, s) in enumerate((("Threads", "threads"), ("Model", "model"), ("Effort", "effort"), ("Usage", "usage")))}
    page = {"Controllers": [{"Actions": keys, "Type": "Keypad"}, {"Actions": dials, "Type": "Encoder"}], "Icon": "", "Name": "T3 Code"}
    empty = {"Controllers": [{"Actions": None, "Type": "Keypad"}, {"Actions": None, "Type": "Encoder"}], "Icon": "", "Name": ""}
    top = {"Device": {"Model": "20GBD9901", "UUID": ""}, "Name": "T3 Code",
           "Pages": {"Current": page_id.lower(), "Default": default_id.lower(), "Pages": [page_id.lower()]}, "Version": "3.0"}
    pkg = {"AppVersion": "7.6.1", "DeviceModel": "20GBD9901", "DeviceSettings": None, "FormatVersion": 1,
           "OSType": "macOS", "OSVersion": "27.0", "RequiredPlugins": [PLUGIN]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    base = f"Profiles/{profile_id}.sdProfile"
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_STORED) as z:
        z.writestr("package.json", json.dumps(pkg, indent=2))
        z.writestr(f"{base}/manifest.json", json.dumps(top, indent=2))
        z.writestr(f"{base}/Profiles/{page_id}/manifest.json", json.dumps(page, indent=2))
        z.writestr(f"{base}/Profiles/{default_id}/manifest.json", json.dumps(empty, indent=2))
    print(OUT)

if __name__ == "__main__":
    main()
