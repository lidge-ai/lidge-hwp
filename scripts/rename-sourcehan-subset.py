#!/usr/bin/env python3
"""Rename only the bundled modified Source Han subset's internal font names.

Requires fonttools==4.62.1 and brotli==1.2.0; installs nothing. Run with
--root <rhwp-root> --apply to update the two assets, or --check (the default)
for read-only proof. Vendor callers select the interpreter using
LIDGE_HWP_FONT_PYTHON, for example:
  "${LIDGE_HWP_FONT_PYTHON:-python3}" scripts/rename-sourcehan-subset.py --check
Legacy filenames are compatibility URLs. Original copyright, license and
trademark notices remain intact. This does not change CSS/renderer aliases.

The pinned fingerprint was measured from the original assets before renaming:
WOFF2 9e419cd16df2ea3b220aa7751320d956ac2493440ba412484d98325078f09d43
OTF   2f86ef9a52acb6d1dad9d915843239123b635d97edd88fd0573a88ffcb4e16f1
It covers every non-name table, head except checkSumAdjustment, untouched name
records, glyph order, raw CharStrings/subroutines, drawn outlines, and all CFF
XML properties after normalizing only the explicitly permitted names.
Upstream font changes require a fresh audit; do not regenerate the fingerprint
just to make a check pass. All output is validated in memory before any write.
"""

import argparse
import hashlib
import json
import sys
from importlib.metadata import version
from io import BytesIO
from pathlib import Path

from fontTools.misc.xmlWriter import XMLWriter
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = (
    "assets/fonts/SourceHanSerifK-OldHangul-subset.woff2",
    "ttfs/opensource/SourceHanSerifK-OldHangul-subset.otf",
)
FAMILY = "LIDGE Old Hangul Serif"
POSTSCRIPT = "LIDGEOldHangulSerif-Regular"
PRIMARY_NAMES = {
    1: FAMILY,
    3: "2.003;LIDGE;" + POSTSCRIPT,
    4: FAMILY,
    6: POSTSCRIPT,
}
FD_NAMES = (POSTSCRIPT + "-Generic", POSTSCRIPT + "-Hangul")
BASELINE_INVARIANTS_SHA256 = "cb69fd41bfd966a28ce614a44e9786283dc45d696decc1b98e69f9633598e6cd"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_hash(value):
    return sha256(json.dumps(value, ensure_ascii=True, sort_keys=True,
                             separators=(",", ":")).encode("ascii"))


def load(data):
    return TTFont(BytesIO(data), recalcTimestamp=False, recalcBBoxes=False)


def rename_cff(font):
    cff = font["CFF "].cff
    require(len(cff.fontNames) == 1, "Expected one CFF font")
    top = cff.topDictIndex[0]
    require(len(top.FDArray) == len(FD_NAMES), "Unexpected CFF FDArray")
    cff.fontNames = [POSTSCRIPT]
    top.FamilyName = FAMILY
    top.FullName = FAMILY
    for fd, name in zip(top.FDArray, FD_NAMES):
        fd.FontName = name


def renamed(data):
    with load(data) as font:
        for record in font["name"].names:
            if record.nameID in PRIMARY_NAMES:
                record.string = PRIMARY_NAMES[record.nameID].encode(record.getEncoding())
        rename_cff(font)
        output = BytesIO()
        font.save(output, reorderTables=False)
        return output.getvalue()


def program_bytes(programs):
    # Read before XML export/drawing decompiles programs; preserve instruction
    # bytes as well as semantics (including hint operators and subroutine IDs).
    return [program.bytecode.hex() for program in programs]


def invariants(data):
    with load(data) as font:
        tables = {str(tag): sha256(font.reader[tag]) for tag in font.reader.keys()
                  if tag not in ("name", "head", "CFF ")}
        head = font.reader["head"]
        tables["head_except_checksum"] = sha256(head[:8] + b"\0" * 4 + head[12:])
        names = []
        for record in font["name"].names:
            key = [record.nameID, record.platformID, record.platEncID, record.langID]
            names.append(key + [None if record.nameID in PRIMARY_NAMES else record.string.hex()])
        order = font.getGlyphOrder()
        cff = font["CFF "].cff
        top = cff.topDictIndex[0]
        programs = {
            "glyphs": program_bytes(top.CharStrings[name] for name in order),
            "global_subrs": program_bytes(cff.GlobalSubrs),
            "local_subrs": [program_bytes(getattr(fd.Private, "Subrs", []))
                            for fd in top.FDArray],
        }
        # CFF XML includes ROS, charset, FDSelect, private dictionaries, hints,
        # metrics, notices and decoded programs. Only naming fields normalize.
        rename_cff(font)
        xml = BytesIO()
        cff.toXML(XMLWriter(xml))
        outlines = []
        glyph_set = font.getGlyphSet()
        for name in order:
            pen = RecordingPen()
            glyph_set[name].draw(pen)
            outlines.append(pen.value)
        return {
            "tables": tables,
            "unchanged_name_records_and_record_keys": json_hash(names),
            "glyph_order": json_hash(order),
            "cmap": json_hash(sorted(font.getBestCmap().items())),
            "hmtx": json_hash(font["hmtx"].metrics),
            "vmtx": json_hash(font["vmtx"].metrics),
            "charstrings_and_subroutines": json_hash(programs),
            "outlines": json_hash(outlines),
            "cff_except_names": sha256(xml.getvalue()),
            "glyph_count": len(order),
            "unicode_mapping_count": len(font.getBestCmap()),
        }


def names_correct(data):
    with load(data) as font:
        records = font["name"].names
        if not set(PRIMARY_NAMES).issubset({r.nameID for r in records}):
            return False
        for record in records:
            if record.nameID in PRIMARY_NAMES:
                if record.toUnicode() != PRIMARY_NAMES[record.nameID]:
                    return False
            if record.nameID in (1, 2, 3, 4, 6, 16, 17, 18, 21, 22, 25):
                if "source" in record.toUnicode().lower():
                    return False
        cff = font["CFF "].cff
        if cff.fontNames != [POSTSCRIPT] or len(cff.topDictIndex) != 1:
            return False
        top = cff.topDictIndex[0]
        return (top.FamilyName == FAMILY and top.FullName == FAMILY
                and tuple(fd.FontName for fd in top.FDArray) == FD_NAMES)


def sfnt_tables(data):
    # Compare decompressed SFNT tables, allowing only the container-dependent
    # head checksum. WOFF2 and OTF must carry exactly the same font data.
    with load(data) as font:
        result = {str(tag): font.reader[tag] for tag in font.reader.keys()}
        head = result["head"]
        result["head"] = head[:8] + b"\0" * 4 + head[12:]
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT / "rhwp",
                        help="rhwp root containing assets/ and ttfs/")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="rename both bundled assets")
    mode.add_argument("--check", action="store_true", help="read-only verification (default)")
    args = parser.parse_args()
    for package, expected in (("fonttools", "4.62.1"), ("brotli", "1.2.0")):
        require(version(package) == expected, f"Requires {package}=={expected}")
    root = args.root.resolve(strict=True)
    paths = [root / asset for asset in ASSETS]
    for path in paths:
        require(not path.is_symlink() and path.resolve() == path,
                f"Refusing symlink asset: {path}")
    originals = [path.read_bytes() for path in paths]
    outputs = []
    reports = []
    for asset, original in zip(ASSETS, originals):
        with load(original) as font:
            expected_flavor = "woff2" if asset.endswith(".woff2") else None
            require(font.flavor == expected_flavor and font.sfntVersion == "OTTO",
                    f"Unexpected font container: {asset}")
        before = invariants(original)
        require(json_hash(before) == BASELINE_INVARIANTS_SHA256,
                f"Non-name data differs from audited original: {asset}")
        correct = names_correct(original)
        require(args.apply or correct, f"Names require renaming: {asset}; run --apply")
        output = original if correct else renamed(original)
        require(names_correct(output), f"Invalid renamed names: {asset}")
        require(invariants(output) == before, f"Non-name data changed: {asset}")
        # Actually serialize a second time; a no-op shortcut alone would not
        # prove deterministic fontTools/Brotli output.
        require(renamed(output) == output, f"Non-idempotent serialization: {asset}")
        outputs.append(output)
        reports.append({"asset": asset, "changed": original != output,
                        "before_sha256": sha256(original), "sha256": sha256(output),
                        "bytes": len(output), "invariants": before})
    require(sfnt_tables(outputs[0]) == sfnt_tables(outputs[1]),
            "WOFF2/SFNT table mismatch")
    # Check both originals again before writing either, guarding against a
    # concurrent worker changing these assets during the verification pass.
    for path, original in zip(paths, originals):
        require(path.read_bytes() == original, f"Asset changed concurrently: {path}")
    if args.apply:
        for path, original, output in zip(paths, originals, outputs):
            if original != output:
                path.write_bytes(output)
        for path, output in zip(paths, outputs):
            require(path.read_bytes() == output, f"Written asset mismatch: {path}")
    print(json.dumps({"status": "PASS", "mode": "apply" if args.apply else "check",
                      "family": FAMILY, "postscript": POSTSCRIPT,
                      "woff2_sfnt_consistent": True, "idempotent": True,
                      "baseline_invariants_sha256": BASELINE_INVARIANTS_SHA256,
                      "assets": reports}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
